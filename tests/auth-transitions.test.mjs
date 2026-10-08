import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAuthTransitions} from '../src/lib/auth-transitions.ts';

function deferred() {
  let resolve;
  const promise=new Promise((done)=>{resolve=done;});
  return {promise,resolve};
}
function fixture(overrides={}) {
  const state={token:null,user:null,session:null,account:null,purges:0};
  const transitions=createAuthTransitions({
    setOfflineAccount:async(id)=>{state.account=id;},
    clearPrivateOfflineData:async()=>{state.purges++;state.account=null;},
    saveToken:async(token)=>{state.token=token;},
    saveStoredUser:async(user)=>{state.user=user;},
    publish:(session)=>{state.session=session;},
    ...overrides,
  });
  return {state,transitions};
}
const student=(id)=>({token:`token-${id}`,user:{id,email:`${id}@local.test`}});

test('logout invalidates private writes immediately and waits out a pending credential write',async()=> {
  const started=deferred(),release=deferred();
  const {state,transitions}=fixture({saveToken:async(token)=> {
    if(token) {started.resolve();await release.promise;}
    state.token=token;
  }});
  const login=transitions.establish(transitions.begin(),student('a'));
  await started.promise;
  const logout=transitions.clear();
  assert.equal(state.purges,1);
  assert.equal(state.account,null);
  release.resolve();
  await Promise.all([login,logout]);
  assert.equal(state.token,null);
  assert.equal(state.user,null);
  assert.equal(state.session,null);
});

test('an old bootstrap or login response cannot resurrect a signed-out account',async()=> {
  const {state,transitions}=fixture();
  const staleVersion=transitions.begin();
  await transitions.clear();
  await transitions.establish(staleVersion,student('a'));
  assert.equal(state.session,null);
  assert.equal(state.token,null);
  assert.equal(state.account,null);
});

test('a new login waits for purge and retains its own credentials after old logout',async()=> {
  const release=deferred();
  const {state,transitions}=fixture({clearPrivateOfflineData:async()=> {
    state.purges++;state.account=null;await release.promise;
  }});
  await transitions.establish(transitions.begin(),student('a'));
  const logout=transitions.clear();
  const login=transitions.establish(transitions.begin(),student('b'));
  release.resolve();
  await Promise.all([logout,login]);
  assert.deepEqual(state.session,student('b'));
  assert.equal(state.token,'token-b');
  assert.equal(state.account,'b');
});

test('late remote signout/reset/change results do not purge a newly started account',async()=> {
  const {state,transitions}=fixture();
  await transitions.establish(transitions.begin(),student('a'));
  const captured=transitions.capture();
  const newLogin=transitions.establish(transitions.begin(),student('b'));
  await transitions.clearIfCurrent(captured,'token-a');
  await newLogin;
  assert.deepEqual(state.session,student('b'));
  assert.equal(state.purges,0);
  await transitions.clearIfCurrent(transitions.capture(),'token-a');
  assert.deepEqual(state.session,student('b'));
  await transitions.clearIfCurrent(transitions.capture(),'token-b');
  assert.equal(state.session,null);
  assert.equal(state.purges,1);
});

test('credential storage failure during logout still removes the active session',async()=> {
  const {state,transitions}=fixture({saveToken:async(token)=> {
    if(token===null) throw new Error('Storage unavailable');
    state.token=token;
  }});
  await transitions.establish(transitions.begin(),student('a'));
  await assert.rejects(transitions.clear(),/Storage unavailable/);
  assert.equal(state.session,null);
  assert.equal(state.user,null);
  assert.equal(state.account,null);
});

test('an old token401 cannot cancel a new login that has begun but has not established',async()=> {
  const {state,transitions}=fixture();
  await transitions.establish(transitions.begin(),student('a'));
  const replacement=transitions.begin();
  await transitions.invalidateToken('token-a');
  assert.equal(transitions.current(replacement),true);
  assert.equal(state.purges,0);
  await transitions.establish(replacement,student('b'));
  await transitions.invalidateToken('token-a');
  assert.deepEqual(state.session,student('b'));
  assert.equal(state.purges,0);
  await transitions.invalidateToken('token-b');
  assert.equal(state.session,null);
});

test('a failed replacement login purges the old session if its token was rejected',async()=> {
  const {state,transitions}=fixture();
  await transitions.establish(transitions.begin(),student('a'));
  const replacement=transitions.begin();
  await transitions.invalidateToken('token-a');
  await transitions.settle(replacement);
  assert.equal(state.session,null);
  assert.equal(state.token,null);
  assert.equal(state.user,null);
});

test('a failed replacement login retains a valid old identity and resumes401 handling',async()=> {
  const {state,transitions}=fixture();
  await transitions.establish(transitions.begin(),student('a'));
  await transitions.settle(transitions.begin());
  assert.deepEqual(transitions.activeSnapshot(),student('a'));
  await transitions.invalidateToken('token-a');
  assert.equal(state.session,null);
});

test('failed identity persistence after writing a token removes both credentials and private data',async()=> {
  let failIdentity=false;
  const {state,transitions}=fixture({saveStoredUser:async(user)=> {
    if(user && failIdentity) throw new Error('Identity write failed');
    state.user=user;
  }});
  await transitions.establish(transitions.begin(),student('a'));
  failIdentity=true;
  await assert.rejects(transitions.establish(transitions.begin(),student('b')),/Identity write failed/);
  assert.equal(state.token,null);
  assert.equal(state.user,null);
  assert.equal(state.session,null);
  assert.equal(state.account,null);
});

test('the old stored identity is cleared before a new account token is persisted',async()=> {
  const {state,transitions}=fixture({saveToken:async(token)=> {
    if(token==='token-b') assert.equal(state.user,null);
    state.token=token;
  }});
  await transitions.establish(transitions.begin(),student('a'));
  await transitions.establish(transitions.begin(),student('b'));
  assert.deepEqual(state.user,student('b').user);
});

test('cancellation during a token write purges partial state before a newer operation settles',async()=> {
  const started=deferred(),release=deferred();
  const {state,transitions}=fixture({saveToken:async(token)=> {
    if(token==='token-b') {started.resolve();await release.promise;}
    state.token=token;
  }});
  await transitions.establish(transitions.begin(),student('a'));
  const interrupted=transitions.establish(transitions.begin(),student('b'));
  await started.promise;
  const latest=transitions.begin();
  release.resolve();await interrupted;await transitions.settle(latest);
  assert.equal(state.token,null);
  assert.equal(state.user,null);
  assert.equal(state.session,null);
  assert.equal(state.account,null);
});
