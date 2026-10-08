export interface SessionIdentity {
  token:string;
  user:{id:string;email:string;email_verified?:boolean};
}

/** Serialize credential writes and invalidate late login/bootstrap responses. */
export function createAuthTransitions(deps:{
  setOfflineAccount:(id:string|null)=>Promise<void>;
  clearPrivateOfflineData:()=>Promise<void>;
  saveToken:(token:string|null)=>Promise<void>;
  saveStoredUser:(user:SessionIdentity['user']|null)=>Promise<void>;
  publish:(session:SessionIdentity|null)=>void;
}) {
  let version=0;
  let establishedVersion=0;
  let session:SessionIdentity|null=null;
  let invalidToken:string|null=null;
  let pending=Promise.resolve();
  function enqueue(operation:()=>Promise<void>) {
    const task=pending.catch(()=>{}).then(operation);
    pending=task;
    return task;
  }
  async function erase(purge=deps.clearPrivateOfflineData()) {
    await purge.catch(()=>{});
    try {await deps.saveToken(null);} finally {
      try {await deps.saveStoredUser(null);} finally {
        session=null;invalidToken=null;establishedVersion=0;deps.publish(null);
      }
    }
  }
  function clear() {
    version++;
    // Invalidate cache writes immediately, before waiting for a login write.
    const purge=deps.clearPrivateOfflineData();
    return enqueue(()=>erase(purge));
  }
  return {
    begin:()=>++version,
    capture:()=>version,
    snapshot:()=>session,
    activeSnapshot:()=>establishedVersion===version?session:null,
    current:(captured:number)=>captured===version,
    establish(captured:number,next:SessionIdentity) {
      return enqueue(async()=> {
        if(captured!==version) return;
        // Cancellation after a partial write must not leave mixed credentials.
        const stillCurrent=async()=> {
          if(captured===version) return true;
          await erase();return false;
        };
        try {
          await deps.setOfflineAccount(next.user.id);
          if(!await stillCurrent()) return;
          // A missing cached identity is safe on restart; an old identity with
          // a newly written token could expose the wrong account's data.
          await deps.saveStoredUser(null);
          if(!await stillCurrent()) return;
          await deps.saveToken(next.token);
          if(!await stillCurrent()) return;
          await deps.saveStoredUser(next.user);
          if(!await stillCurrent()) return;
          session=next;establishedVersion=captured;invalidToken=null;deps.publish(next);
        } catch(error) {
          if(captured===version) version++;
          await erase().catch(()=>{});
          throw error;
        }
      });
    },
    clear,
    clearIfCurrent(captured:number,token:string) {
      return captured===version && establishedVersion===captured && session?.token===token?clear():Promise.resolve();
    },
    invalidateToken(token:string) {
      if(session?.token!==token) return Promise.resolve();
      if(establishedVersion===version) return clear();
      // Preserve a pending replacement login. If it fails, purge this invalid
      // old session when the operation settles instead of reactivating it.
      invalidToken=token;
      return Promise.resolve();
    },
    settle(captured:number) {
      if(captured!==version || !session) return Promise.resolve();
      establishedVersion=captured;
      return invalidToken===session.token?clear():Promise.resolve();
    },
  };
}
