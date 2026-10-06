import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';

process.env.JWT_SECRET ||= 'local-auth-regression-secret';
const {hashPassword,verifyPassword,signToken,verifyToken,createAuthLimiter,registerAuthRoutes}=await import('../src/auth.js');

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
