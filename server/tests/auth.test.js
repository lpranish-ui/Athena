import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { after,before,test } from 'node:test';
import express from 'express';
import pg from 'pg';

process.env.JWT_SECRET ||= 'local-auth-regression-secret';
const {hashPassword,verifyPassword,signToken,verifyToken,createAuthLimiter,createRequireAuth,registerAuthRoutes}=await import('../src/auth.js');
const {createAuthEmailSender}=await import('../src/auth-email.js');

test('asynchronous password hashing verifies existing scrypt records',async()=> {
  const salt='a1'.repeat(16);
  const legacy=`scrypt:${salt}:${crypto.scryptSync('LegacyPassword!',salt,32,{N:16384,r:8,p:1}).toString('hex')}`;
  assert.equal(await verifyPassword('LegacyPassword!',legacy),true);
  assert.equal(await verifyPassword('incorrect',legacy),false);
  const stored=await hashPassword('NewPassword!');
  assert.equal(await verifyPassword('NewPassword!',stored),true);
  assert.notEqual(stored,await hashPassword('NewPassword!'));
});

test('missing JWT secret refuses both signing and verification',()=> {
  const url=new URL('../src/auth.js',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `const {signToken,verifyToken}=await import(${JSON.stringify(url)}); let refused=false; try{signToken('test-user')}catch(error){refused=error.message.includes('JWT_SECRET')} if(!refused || verifyToken('a.b.c')!==null) process.exit(1);`],
  {env:{...process.env,JWT_SECRET:'',DATABASE_URL:''},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
});

test('token verification rejects tampering and extra segments',()=> {
  const token=signToken('test-user');
  assert.equal(verifyToken(token).sub,'test-user');
  assert.equal(verifyToken(token+'.extra'),null);
  assert.equal(verifyToken(token.slice(0,-1)+(token.at(-1)==='a'?'b':'a')),null);
});

function response() {
  const res=new EventEmitter();
  res.set=()=>res;
  res.status=(status)=>{res.statusCode=status;return res;};
  res.json=(body)=>{res.body=body;return res;};
  res.end=()=>{res.ended=true;return res;};
  return res;
}

test('auth limits attempts across IPs and releases concurrent slots on completion',()=> {
  let time=0;
  const limit=createAuthLimiter({maxAttempts:10,maxAccountAttempts:2,maxConcurrent:1,windowMs:1000,now:()=>time});
  const req={ip:'127.0.0.1',body:{email:'student@local.test'}};
  let admitted=0;
  const first=response();limit(req,first,()=>admitted++);
  const concurrent=response();limit({...req,body:{email:'other@local.test'}},concurrent,()=>admitted++);
  assert.equal(concurrent.statusCode,429);
  first.emit('finish');
  const second=response();limit(req,second,()=>admitted++);second.emit('finish');
  const third=response();limit({...req,ip:'127.0.0.2'},third,()=>admitted++);
  assert.equal(third.statusCode,429);
  assert.equal(admitted,2);
  time=1001;
  limit(req,response(),()=>admitted++);
  assert.equal(admitted,3);
});

test('disconnecting an auth client retains its work slot until the handler ends',()=> {
  const limit=createAuthLimiter({maxAttempts:10,maxAccountAttempts:10,maxConcurrent:1});
  const req={ip:'127.0.0.1',body:{email:'working@local.test'}};
  let admitted=0;
  const first=response();
  limit(req,first,()=>admitted++);
  first.emit('close');
  const blocked=response();
  limit({...req,body:{email:'next@local.test'}},blocked,()=>admitted++);
  assert.equal(blocked.statusCode,429);
  assert.equal(admitted,1);
  assert.equal(first.end('response after disconnect'),first);
  const second=response();
  limit({...req,body:{email:'next@local.test'}},second,()=>admitted++);
  assert.equal(admitted,2);
  // A later finish event must not release another request's slot.
  first.emit('finish');
  const stillBlocked=response();
  limit({...req,body:{email:'third@local.test'}},stillBlocked,()=>admitted++);
  assert.equal(stillBlocked.statusCode,429);
  second.end();
});

test('session database failures return JSON instead of escaping async Express handlers',async()=> {
  const app=express();
  app.use(express.json());
  registerAuthRoutes(app,{database:{one:async()=>{throw new Error('Simulated database interruption');}},limiter:(_req,_res,next)=>next()});
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve)=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const [route,method] of [['/api/me','GET'],['/api/auth/refresh','POST']]) {
      const result=await fetch(base+route,{method,headers:{authorization:'Bearer '+signToken('test-user')}});
      assert.equal(result.status,503);
      assert.equal(typeof (await result.json()).error,'string');
    }
  } finally {await new Promise((resolve)=>server.close(resolve));}
});

test('authentication checks the current account version and preserves only version-zero legacy tokens',async()=> {
  const row={id:'existing-user',email:'existing@local.test',token_version:0,email_verified_at:null};
  const middleware=createRequireAuth({one:async()=>row});
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body=Buffer.from(JSON.stringify({sub:row.id,exp:Math.floor(Date.now()/1000)+60})).toString('base64url');
  const legacy=`${header}.${body}.`+crypto.createHmac('sha256',process.env.JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  const check=async(token)=> {
    const res=response();let next=false;
    await middleware({headers:{authorization:'Bearer '+token}},res,()=>{next=true;});
    return {res,next};
  };
  assert.equal((await check(legacy)).next,true);
  row.token_version=1;
  assert.equal((await check(legacy)).res.statusCode,401);
  assert.equal((await check(signToken(row.id,0))).res.statusCode,401);
  assert.equal((await check(signToken(row.id,1))).next,true);
});

test('email sender uses private route links and exposes neither provider response nor tokens in errors',async()=> {
  let sent;
  const sender=createAuthEmailSender({apiKey:'mock-api-key',from:'Athena <local@example.test>',publicUrl:'https://athena.example.test',
    fetchImpl:async(url,options)=>{sent={url,options};return {ok:true};}});
  await sender.send({to:'student@example.test',purpose:'password_reset',token:'private-reset-token'});
  assert.equal(sent.url,'https://api.resend.com/emails');
  const email=JSON.parse(sent.options.body);
  assert.ok(email.text.includes('https://athena.example.test/reset-password?token=private-reset-token'));
  assert.equal(email.to[0],'student@example.test');
  const failed=createAuthEmailSender({apiKey:'mock',from:'local@example.test',publicUrl:'https://athena.example.test',
    fetchImpl:async()=>({ok:false,text:async()=>{throw new Error('Provider details must not be read');}})});
  await assert.rejects(failed.send({to:'private@example.test',purpose:'email_verification',token:'sensitive'}),
    (error)=>error.status===503 && !error.message.includes('sensitive') && !error.message.includes('private@'));
  assert.throws(()=>createAuthEmailSender({apiKey:'',from:'',publicUrl:''}).assertAvailable(),(error)=>error.status===503);
});

test('unconfigured recovery responds503 before looking up an account',async()=> {
  const app=express();app.use(express.json());let lookups=0;
  registerAuthRoutes(app,{database:{one:async()=>{lookups++;return null;}},
    emailSender:createAuthEmailSender({apiKey:'',from:'',publicUrl:''}),limiter:(_req,_res,next)=>next()});
  const listener=app.listen(0,'127.0.0.1');
  await new Promise((resolve)=>listener.once('listening',resolve));
  try {
    const replies=[];
    for(const email of ['existing@local.test','unknown@local.test']) {
      const res=await fetch(`http://127.0.0.1:${listener.address().port}/api/auth/password-reset/request`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
      assert.equal(res.status,503);replies.push(await res.json());
    }
    assert.deepEqual(replies[0],replies[1]);assert.equal(lookups,0);
  } finally {await new Promise((resolve)=>listener.close(resolve));}
});

// Integration fixtures are isolated in their own schema in a dedicated local DB.
const connectionString=process.env.TEST_DATABASE_URL;
const dbOptions={skip:!connectionString};
let admin,pool,database,authServer,authBase,schema;
const emails=[];
const injectedEmail={assertAvailable:()=>{},send:async(message)=>{emails.push(message);}};
const noLimit=(_req,_res,next)=>next();

before(async()=> {
  if(!connectionString) return;
  const url=new URL(connectionString);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Auth tests require loopback PostgreSQL.');
  assert.equal(url.pathname,'/athena_test','Auth tests must use athena_test.');
  schema=`auth_${crypto.randomUUID().replaceAll('-','')}`;
  admin=new pg.Pool({connectionString,max:1});await admin.query(`create schema ${schema}`);
  pool=new pg.Pool({connectionString,options:`-c search_path=${schema},public`,max:8});
  await pool.query(await readFile(new URL('../sql/schema.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../sql/0007_auth_security.sql',import.meta.url),'utf8'));
  database={query:(...args)=>pool.query(...args),one:async(...args)=>(await pool.query(...args)).rows[0]??null,
    withTransaction:async(operation)=> {
      const client=await pool.connect();
      try {await client.query('begin');const result=await operation(client);await client.query('commit');return result;}
      catch(error) {await client.query('rollback');throw error;} finally {client.release();}
    }};
  const app=express();app.use(express.json());
  registerAuthRoutes(app,{database,emailSender:injectedEmail,limiter:noLimit,actionLimiter:noLimit});
  authServer=app.listen(0,'127.0.0.1');await new Promise((resolve)=>authServer.once('listening',resolve));
  authBase=`http://127.0.0.1:${authServer.address().port}`;
});

after(async()=> {
  if(authServer) await new Promise((resolve)=>authServer.close(resolve));
  if(pool) await pool.end();
  if(admin) {if(schema) await admin.query(`drop schema ${schema} cascade`);await admin.end();}
});

async function apiCall(route,{method='POST',body,token}={}) {
  const res=await fetch(authBase+route,{method,headers:{...(body?{'content-type':'application/json'}:{}),
    ...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,body:await res.json()};
}
async function account() {
  const email=`${crypto.randomUUID()}@local.test`,password='OriginalLocalPassword!';
  const user=await database.one('insert into users(email,password_hash) values ($1,$2) returning *',[email,await hashPassword(password)]);
  await database.query('insert into profiles(id) values ($1)',[user.id]);
  return {...user,password,token:signToken(user.id,user.token_version)};
}
async function requestEmail(user,purpose='password_reset') {
  const beforeCount=emails.length;
  const result=await apiCall(purpose==='password_reset'?'/api/auth/password-reset/request':'/api/auth/verification/request',
    {body:{email:user.email},token:purpose==='password_reset'?undefined:user.token});
  assert.equal(result.status,202);
  const deadline=Date.now()+3000;
  while(emails.length===beforeCount && Date.now()<deadline) await new Promise((resolve)=>setTimeout(resolve,5));
  assert.equal(emails.length,beforeCount+1,'Mock email should be delivered.');
  assert.equal(emails.at(-1).purpose,purpose);
  assert.equal(emails.at(-1).to,user.email);
  return {token:emails.at(-1).token,response:result.body};
}

test('reset requests are generic; hashed single-use links replace the password and revoke existing sessions',dbOptions,async()=> {
  const user=await account();
  const {token,response:message}=await requestEmail(user);
  const unknown=await apiCall('/api/auth/password-reset/request',{body:{email:'unknown@local.test'}});
  assert.equal(unknown.status,202);assert.deepEqual(message,unknown.body);
  assert.equal(Object.hasOwn(message,'token'),false);
  const stored=await database.one('select * from auth_action_tokens where user_id=$1',[user.id]);
  assert.equal(stored.token_hash,crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(stored.token_hash,token);
  assert.ok(stored.expires_at-new Date(stored.created_at)<=30*60*1000+1000);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token,password:'UpdatedLocalPassword!'}})).status,200);
  assert.equal((await apiCall('/api/me',{method:'GET',token:user.token})).status,401);
  assert.equal((await apiCall('/api/auth/signin',{body:{email:user.email,password:user.password}})).status,401);
  const signin=await apiCall('/api/auth/signin',{body:{email:user.email,password:'UpdatedLocalPassword!'}});
  assert.equal(signin.status,200);assert.equal(verifyToken(signin.body.token).v,1);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token,password:'AnotherLocalPassword!'}})).status,400);
});

test('simultaneous reset confirms consume a link exactly once',dbOptions,async()=> {
  const user=await account();const {token}=await requestEmail(user);
  const responses=await Promise.all([1,2].map(()=>apiCall('/api/auth/password-reset/confirm',{body:{token,password:'ConcurrentLocalPassword!'}})));
  assert.deepEqual(responses.map((res)=>res.status).sort(),[200,400]);
  assert.equal((await database.one('select token_version from users where id=$1',[user.id])).token_version,1);
});

test('expired or superseded links cannot change a password',dbOptions,async()=> {
  const user=await account();const first=await requestEmail(user);
  await database.query('update auth_action_tokens set expires_at=now()-interval \'1 second\' where user_id=$1',[user.id]);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token:first.token,password:'RejectedPassword!'}})).status,400);
  const second=await requestEmail(user);const third=await requestEmail(user);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token:second.token,password:'RejectedPassword!'}})).status,400);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token:third.token,password:'FinalLocalPassword!'}})).status,200);
  assert.equal((await database.one('select token_version from users where id=$1',[user.id])).token_version,1);
});

test('verification is purpose-bound, expiring, single-use and visible to existing authenticated accounts',dbOptions,async()=> {
  const user=await account();const {token}=await requestEmail(user,'email_verification');
  const stored=await database.one('select * from auth_action_tokens where user_id=$1',[user.id]);
  assert.ok(stored.expires_at-new Date(stored.created_at)>=24*60*60*1000-1000);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token,password:'MustNotChangePassword!'}})).status,400);
  assert.equal((await apiCall('/api/auth/verification/confirm',{body:{token}})).status,200);
  assert.equal((await apiCall('/api/auth/verification/confirm',{body:{token}})).status,400);
  const me=await apiCall('/api/me',{method:'GET',token:user.token});
  assert.equal(me.status,200);assert.equal(me.body.user.email_verified,true);
  const sentBefore=emails.length;
  assert.equal((await apiCall('/api/auth/verification/request',{body:{},token:user.token})).status,202);
  assert.equal(emails.length,sentBefore);
  const other=await account();const expiring=await requestEmail(other,'email_verification');
  await database.query('update auth_action_tokens set expires_at=now()-interval \'1 second\' where user_id=$1',[other.id]);
  assert.equal((await apiCall('/api/auth/verification/confirm',{body:{token:expiring.token}})).status,400);
});

test('signout-all invalidates every prior token and account deletion immediately invalidates new tokens',dbOptions,async()=> {
  const user=await account();
  assert.equal((await apiCall('/api/auth/signout-all',{body:{},token:user.token})).status,200);
  assert.equal((await apiCall('/api/auth/refresh',{body:{},token:user.token})).status,401);
  const signed=await apiCall('/api/auth/signin',{body:{email:user.email,password:user.password}});
  assert.equal(signed.status,200);
  assert.equal((await apiCall('/api/me',{method:'GET',token:signed.body.token})).status,200);
  assert.equal((await apiCall('/api/account',{method:'DELETE',token:signed.body.token})).status,200);
  assert.equal((await apiCall('/api/me',{method:'GET',token:signed.body.token})).status,401);
});

test('refresh cannot mint a new valid session when revocation races its middleware check',dbOptions,async()=> {
  const user=await account();let checks=0;
  const racingDatabase={...database,one:async(...args)=> {
    const row=await database.one(...args);
    if(++checks===1) await database.query('update users set token_version=token_version+1 where id=$1',[user.id]);
    return row;
  }};
  const app=express();app.use(express.json());
  registerAuthRoutes(app,{database:racingDatabase,emailSender:injectedEmail,limiter:noLimit,actionLimiter:noLimit});
  const listener=app.listen(0,'127.0.0.1');await new Promise((resolve)=>listener.once('listening',resolve));
  try {
    const res=await fetch(`http://127.0.0.1:${listener.address().port}/api/auth/refresh`,{
      method:'POST',headers:{authorization:'Bearer '+user.token}});
    assert.equal(res.status,401);assert.equal(Object.hasOwn(await res.json(),'token'),false);
  } finally {await new Promise((resolve)=>listener.close(resolve));}
});

test('password change requires the current password, revokes sessions and supersedes outstanding reset links',dbOptions,async()=> {
  const user=await account();const {token:reset}=await requestEmail(user);
  assert.equal((await apiCall('/api/auth/password/change',{token:user.token,body:{currentPassword:'wrong',password:'ChangedLocalPassword!'}})).status,400);
  assert.equal((await database.one('select token_version from users where id=$1',[user.id])).token_version,0);
  assert.equal((await apiCall('/api/auth/password/change',{token:user.token,body:{currentPassword:user.password,password:'ChangedLocalPassword!'}})).status,200);
  assert.equal((await apiCall('/api/me',{method:'GET',token:user.token})).status,401);
  assert.equal((await apiCall('/api/auth/password-reset/confirm',{body:{token:reset,password:'MustNotRestore!'}})).status,400);
  assert.equal((await apiCall('/api/auth/signin',{body:{email:user.email,password:'ChangedLocalPassword!'}})).status,200);
});
