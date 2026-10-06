import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';

process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';
const { createApp } = await import('../src/app.js');
const { createChapterService, splitChapterContent } = await import('../src/chapters.js');
const { createUploadService, createUploadWorker } = await import('../src/uploads.js');

test('splitting midway through a page preserves its active page at offset zero', () => {
  const result=splitChapterContent({content:'abcdefghij',page_map:[{page:1,char_start:0},{page:2,char_start:4},{page:3,char_start:8}],first_page:1,last_page:3},6);
  assert.equal(result.head.content,'abcdef');
  assert.equal(result.tail.content,'ghij');
  assert.deepEqual(result.head.page_map,[{page:1,char_start:0},{page:2,char_start:4}]);
  assert.deepEqual(result.tail.page_map,[{page:2,char_start:0},{page:3,char_start:2}]);
  assert.equal(result.head.last_page,2);
  assert.equal(result.tail.first_page,2);
  assert.throws(()=>splitChapterContent({content:'abc'},0),/Choose a split/);
});

const connectionString=process.env.TEST_DATABASE_URL;
const integration=test;
let pool;
let admin;
let database;
let server;
let base;
let userA;
let userB;
let schema;

before(async () => {
  if (!connectionString) return;
  const url=new URL(connectionString);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Tests require loopback PostgreSQL.');
  assert.equal(url.pathname,'/athena_test','Tests must use the dedicated athena_test database.');
  schema=`test_${crypto.randomUUID().replaceAll('-','')}`;
  admin=new pg.Pool({connectionString,max:1});
  await admin.query(`create schema ${schema}`);
  pool=new pg.Pool({connectionString,options:`-c search_path=${schema},public`,max:8});
  await pool.query(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
  database={
    query:(...args)=>pool.query(...args),
    one:async (...args)=>(await pool.query(...args)).rows[0] ?? null,
    many:async (...args)=>(await pool.query(...args)).rows,
    withTransaction:async (fn)=> {
      const client=await pool.connect();
      try { await client.query('begin'); const result=await fn(client); await client.query('commit'); return result; }
      catch(error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
  };
  userA=(await database.one("insert into users(email,password_hash) values ('a@local.test','fixture') returning id")).id;
  userB=(await database.one("insert into users(email,password_hash) values ('b@local.test','fixture') returning id")).id;
  const app=createApp({database,registerAuthentication:()=>{},authenticate:(req,res,next)=> {
    req.user={id:req.headers['x-test-user'] ?? userA}; next();
  },aiLimiter:null,services:{ingestFile:async ()=> {throw new Error('Unauthorized ingestion must not run.');}}});
  server=app.listen(0,'127.0.0.1');
  await new Promise((resolve)=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if(server) await new Promise((resolve)=>server.close(resolve));
  if(pool) await pool.end();
  if(admin) { if(schema) await admin.query(`drop schema ${schema} cascade`); await admin.end(); }
});

async function request(route,{method='GET',body,user=userA,headers={}}={}) {
  const binary=Buffer.isBuffer(body);
  const response=await fetch(base+route,{method,headers:{'x-test-user':user,
    ...(body===undefined?{}:{'content-type':binary?'application/octet-stream':'application/json'}),...headers},
    ...(body===undefined?{}:{body:binary?body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
}

async function fixture({owner=userA,title='Fixture book',content='Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.',number=1}={}) {
  const book=await database.one("insert into books(title,owner_id,file_type,status) values ($1,$2,'txt','ready') returning *",[title,owner]);
  const chapter=await database.one('insert into chapters(book_id,title,number,content) values ($1,$2,$3,$4) returning *',[book.id,title,number,content]);
  const set=await database.one('insert into mcq_sets(chapter_id,chapter_ids,user_id,title) values ($1,$2::uuid[],$3,$4) returning *',[chapter.id,[chapter.id],owner,title]);
  const question=await database.one(`insert into mcqs(set_id,chapter_id,question,options,correct_index)
    values ($1,$2,'Fixture question?','["Right","Wrong"]'::jsonb,0) returning *`,[set.id,chapter.id]);
  return {book,chapter,set,question};
}

integration('reviews reject foreign MCQs, and due reads hide legacy unauthorized rows', {skip:!connectionString},async ()=> {
  const foreign=await fixture({owner:userB});
  const response=await request('/api/reviews',{method:'POST',body:{rows:[{question_id:foreign.question.id}]}});
  assert.equal(response.status,404);
  assert.equal((await database.one('select count(*)::int as count from reviews where user_id=$1 and question_id=$2',[userA,foreign.question.id])).count,0);
  await database.query('insert into reviews(user_id,question_id) values ($1,$2)',[userA,foreign.question.id]);
  const due=await request('/api/reviews/due');
  assert.equal(due.status,200);
  assert.ok(!due.body.some((row)=>row.id===foreign.question.id));
  const owned=await fixture();
  const valid=await request('/api/reviews',{method:'POST',body:{rows:[{question_id:owned.question.id}]}});
  assert.equal(valid.status,200);
  assert.ok((await request('/api/reviews/due')).body.some((row)=>row.id===owned.question.id));
});

integration('signup, signin and session refresh use the injected local database',{skip:!connectionString},async()=> {
  const authApp=createApp({database,aiLimiter:null});
  const authServer=authApp.listen(0,'127.0.0.1');
  await new Promise((resolve)=>authServer.once('listening',resolve));
  const authBase=`http://127.0.0.1:${authServer.address().port}`;
  const email=`signup-${crypto.randomUUID()}@local.test`;
  try {
    const signup=await fetch(authBase+'/api/auth/signup',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email,password:'CompatiblePassword!',full_name:'Local Student'})});
    assert.equal(signup.status,201);
    const created=await signup.json();
    assert.equal((await database.one('select full_name from profiles where id=$1',[created.user.id])).full_name,'Local Student');
    const signin=await fetch(authBase+'/api/auth/signin',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({email,password:'CompatiblePassword!'})});
    assert.equal(signin.status,200);
    const signed=await signin.json();
    const refresh=await fetch(authBase+'/api/auth/refresh',{method:'POST',headers:{authorization:'Bearer '+signed.token}});
    assert.equal(refresh.status,200);
    const me=await fetch(authBase+'/api/me',{headers:{authorization:'Bearer '+signed.token}});
    assert.equal(me.status,200);
    assert.equal((await me.json()).user.email,email);
  } finally {await new Promise((resolve)=>authServer.close(resolve));}
});

integration('unauthorized legacy uploads cannot change another account processing book',{skip:!connectionString},async()=> {
  const foreign=await fixture({owner:userB});
  await database.query("update books set status='processing',status_message='Uploading…' where id=$1",[foreign.book.id]);
  const response=await request(`/api/upload/${foreign.book.id}`,{method:'POST',body:Buffer.from('foreign data')});
  assert.equal(response.status,403);
  const book=await database.one('select status,status_message from books where id=$1',[foreign.book.id]);
  assert.deepEqual(book,{status:'processing',status_message:'Uploading…'});
});

integration('mock pool joins book metadata and counts beyond the 500-question sample',{skip:!connectionString},async()=> {
  const value=await fixture({title:'Large question pool'});
  await database.query(`insert into mcqs(set_id,chapter_id,question,options,correct_index,position)
    select $1,$2,'Q '||n,'["A","B"]'::jsonb,0,n+1 from generate_series(1,620) n`,[value.set.id,value.chapter.id]);
  await database.query("insert into flags(user_id,question_id,reason) values ($1,$2,'test')",[userA,value.question.id]);
  const books=await request('/api/mcqs/books');
  assert.equal(books.body.find((row)=>row.id===value.book.id).count,620);
  const sampled=await request(`/api/mcqs?book_id=${value.book.id}&limit=500&sample=true`);
  assert.equal(sampled.status,200);
  assert.equal(sampled.body.length,500);
  assert.equal(new Set(sampled.body.map((row)=>row.id)).size,500);
  assert.ok(sampled.body.every((row)=>row.book_id===value.book.id && row.book_title===value.book.title && row.id!==value.question.id));
});

integration('chapter split inserts directly after source and merge preserves references and notes',{skip:!connectionString},async()=> {
  const value=await fixture({title:'Edit book',content:'First page.\n\nSecond page.\n\nThird page.'});
  const cut=value.chapter.content.indexOf('Second');
  await database.query('update chapters set page_map=$2::jsonb,first_page=1,last_page=3 where id=$1',
    [value.chapter.id,JSON.stringify([{page:1,char_start:0},{page:2,char_start:cut},{page:3,char_start:value.chapter.content.indexOf('Third')}])]);
  await database.query('insert into chapters(book_id,title,number,content) values ($1,\'Next chapter\',2,\'Next text\')',[value.book.id]);
  await database.query("insert into reader_notes(user_id,book_id,chapter_id,paragraph_index,kind,text,color) values ($1,$2,$3,1,'highlight','Second page.','blue')",[userA,value.book.id,value.chapter.id]);
  await database.query('update mcqs set supporting_quote=$2 where id=$1',[value.question.id,'Second page.']);
  const split=await request(`/api/chapters/${value.chapter.id}/split`,{method:'POST',body:{cut}});
  assert.equal(split.status,200);
  const tailId=split.body.newChapterId;
  const chapters=await database.many('select * from chapters where book_id=$1 order by number',[value.book.id]);
  assert.deepEqual(chapters.map((row)=>row.number),[1,2,3]);
  assert.equal(chapters[1].id,tailId);
  assert.equal(chapters[1].page_map[0].char_start,0);
  assert.equal(chapters[1].first_page,2);
  assert.equal((await database.one('select chapter_id from mcqs where id=$1',[value.question.id])).chapter_id,tailId);
  assert.equal((await database.one('select chapter_id from reader_notes where book_id=$1',[value.book.id])).chapter_id,tailId);
  const merged=await request(`/api/chapters/${tailId}/merge`,{method:'POST',body:{intoId:value.chapter.id}});
  assert.equal(merged.status,200);
  const set=await database.one('select chapter_id,chapter_ids from mcq_sets where id=$1',[value.set.id]);
  assert.equal(set.chapter_id,value.chapter.id);
  assert.deepEqual(set.chapter_ids,[value.chapter.id]);
  assert.equal((await database.one('select chapter_id from mcqs where id=$1',[value.question.id])).chapter_id,value.chapter.id);
  const note=await database.one('select chapter_id,color from reader_notes where book_id=$1',[value.book.id]);
  assert.deepEqual(note,{chapter_id:value.chapter.id,color:'blue'});
});

integration('chapter split failure rolls back head, inserted tail and chapter order',{skip:!connectionString},async()=> {
  const value=await fixture();
  const failing={...database,withTransaction:(fn)=>database.withTransaction((client)=>fn({query:async (sql,params)=> {
    if(sql.startsWith('update chapters set content=')) throw new Error('Simulated write failure');
    return client.query(sql,params);
  }}))};
  await assert.rejects(createChapterService(failing).split(value.chapter.id,userA,20),/Simulated write failure/);
  const rows=await database.many('select * from chapters where book_id=$1',[value.book.id]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].content,value.chapter.content);
  assert.equal(rows[0].number,1);
});

integration('durable uploads reconcile retries, reject incomplete files and recover an expired processing lease',{skip:!connectionString},async()=> {
  const service=createUploadService(database);
  const bytes=Buffer.from('Durable plain text content. '.repeat(80));
  const upload=await service.create(userA,{fileName:'durable.txt',fileSize:bytes.length});
  const first=bytes.subarray(0,600);
  assert.deepEqual(await service.append(upload.bookId,userA,first,'0'),{received:600});
  assert.deepEqual(await service.append(upload.bookId,userA,first,'0'),{received:600});
  await assert.rejects(service.append(upload.bookId,userA,Buffer.from('different'),0),(error)=>error.status===409 && error.received===600);
  await assert.rejects(service.append(upload.bookId,userB,first,600),(error)=>error.status===404);
  await assert.rejects(service.finish(upload.bookId,userA),(error)=>error.status===409 && error.received===600);
  assert.equal((await service.state(upload.bookId,userA)).received,600);
  await service.append(upload.bookId,userA,bytes.subarray(600),'600');
  await service.finish(upload.bookId,userA);
  await database.query("update upload_sessions set status='processing',lease_at=now()-interval '1 hour',lease_token=$2,attempts=1 where book_id=$1",[upload.bookId,crypto.randomUUID()]);
  const tempDir=await mkdtemp(path.join(os.tmpdir(),'athena-upload-test-'));
  let processed=0;
  const worker=createUploadWorker({database,tempDir,processFile:async({bookId,filePath,userId})=> {
    processed++;
    assert.equal(userId,userA);
    assert.deepEqual(await readFile(filePath),bytes);
    await database.query("update books set status='ready',status_message=null where id=$1",[bookId]);
  }});
  try {
    assert.equal(await worker.runOnce(),true);
    assert.equal(processed,1);
    assert.equal((await service.state(upload.bookId,userA)).status,'done');
    assert.equal((await database.one('select count(*)::int as count from upload_chunks where book_id=$1',[upload.bookId])).count,0);
    assert.deepEqual(await service.finish(upload.bookId,userA),{status:'ready'});
  } finally { await worker.stop(); await rmdir(tempDir); }
});

integration('concurrent group starts, transitions and answers serialize per room',{skip:!connectionString},async()=> {
  const value=await fixture({title:'Group concurrency'});
  await database.query(`insert into mcqs(set_id,chapter_id,question,options,correct_index,position)
    select $1,$2,'Round '||n,'["Right","Wrong"]'::jsonb,0,n+1 from generate_series(1,2) n`,[value.set.id,value.chapter.id]);
  const created=await request('/api/group/rooms',{method:'POST',body:{setId:value.set.id}});
  assert.equal(created.status,201);
  const code=created.body.code;
  await request(`/api/group/rooms/${code}/join`,{method:'POST',body:{},user:userB});
  const starts=await Promise.all([1,2].map(()=>request(`/api/group/rooms/${code}/start`,{method:'POST',body:{}})));
  assert.deepEqual(starts.map((row)=>row.status).sort(),[200,409]);
  await database.query("update group_rooms set question_ends_at=now()-interval '1 second' where code=$1",[code]);
  const reveals=await Promise.all([1,2].map(()=>request(`/api/group/rooms/${code}`)));
  assert.ok(reveals.every((row)=>row.body.room.phase==='reveal'));
  assert.equal(reveals[0].body.room.revealEndsAt,reveals[1].body.room.revealEndsAt);
  await database.query("update group_rooms set reveal_ends_at=now()-interval '1 second' where code=$1",[code]);
  const questions=await Promise.all([1,2].map(()=>request(`/api/group/rooms/${code}`)));
  assert.ok(questions.every((row)=>row.body.room.phase==='question' && row.body.room.currentIndex===1));
  assert.equal(questions[0].body.room.questionEndsAt,questions[1].body.room.questionEndsAt);
  const answers=await Promise.all([1,2].map(()=>request(`/api/group/rooms/${code}/answer`,{method:'POST',body:{questionIndex:1,optionIndex:0}})));
  assert.deepEqual(answers.map((row)=>row.status).sort(),[200,409]);
  const player=await database.one('select correct_count from group_players where room_id=$1 and user_id=$2',[created.body.roomId,userA]);
  assert.equal(player.correct_count,1);
});
