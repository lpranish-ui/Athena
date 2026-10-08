// Authentication and account-scoped offline data share a single session lifecycle.
import {createContext,useCallback,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import {api,apiRequest,ApiError,isApiConfigured,loadStoredUser,loadToken,saveStoredUser,saveToken} from './apiClient';
import {clearPrivateOfflineData,setOfflineAccount} from './offline';
import {createAuthTransitions,type SessionIdentity} from './auth-transitions';
import {onSessionInvalid} from './session-events';

export interface AuthUser {id:string;email:string;email_verified?:boolean}
export interface AuthSession extends SessionIdentity {user:AuthUser}
interface AuthContextValue {
  session:AuthSession|null;user:AuthUser|null;loading:boolean;
  signIn:(email:string,password:string)=>Promise<{error:string|null}>;
  signUp:(email:string,password:string,fullName:string)=>Promise<{error:string|null;needsConfirmation:boolean}>;
  signOut:()=>Promise<void>;
  refreshUser:()=>Promise<void>;
  signOutAll:()=>Promise<void>;
  changePassword:(currentPassword:string,password:string)=>Promise<void>;
  resetPassword:(token:string,password:string)=>Promise<void>;
}
const AuthContext=createContext<AuthContextValue|undefined>(undefined);

export function AuthProvider({children}:{children:ReactNode}) {
  const [session,setSession]=useState<AuthSession|null>(null);
  const [loading,setLoading]=useState(isApiConfigured);
  const [transitions]=useState(()=>createAuthTransitions({setOfflineAccount,clearPrivateOfflineData,saveToken,saveStoredUser,
    publish:setSession}));

  useEffect(()=>onSessionInvalid((token)=> {
    void transitions.invalidateToken(token).catch(()=>{});
  }),[transitions]);

  useEffect(()=> {
    if(!isApiConfigured) return;
    let mounted=true;
    const version=transitions.begin();
    const current=()=>mounted && transitions.current(version);
    void (async()=> {
      try {
        const token=await loadToken();
        if(!current()) return;
        if(!token) {await transitions.clear();return;}
        const stored=await loadStoredUser();
        if(!current()) return;
        if(stored) {
          await transitions.establish(version,{user:stored,token});
          if(current()) setLoading(false);
        }
        try {
          const me=await apiRequest<{user:AuthUser}>('GET','/api/me',{token,timeoutMs:10000});
          if(current()) await transitions.establish(version,{user:me.user,token});
        } catch(error) {
          if(current() && error instanceof ApiError && error.status===401) await transitions.clear();
          // Offline access retains the cached identity; revoked online sessions are purged.
        }
      } catch {
        if(current()) await transitions.clear().catch(()=>{});
      } finally {if(mounted) setLoading(false);}
    })();
    return ()=> {mounted=false;};
  },[transitions]);

  const signIn=useCallback(async(email:string,password:string)=> {
    const version=transitions.begin();
    try {
      const result=await api.post<AuthSession>('/api/auth/signin',{email,password},null);
      if(!transitions.current(version)) return {error:'This sign-in was cancelled.'};
      await transitions.establish(version,result);
      return {error:transitions.current(version)?null:'This sign-in was cancelled.'};
    } catch(error) {
      await transitions.settle(version).catch(()=>{});
      return {error:error instanceof Error?error.message:'Could not sign you in.'};
    }
  },[transitions]);

  const signUp=useCallback(async(email:string,password:string,fullName:string)=> {
    const version=transitions.begin();
    try {
      const result=await api.post<AuthSession>('/api/auth/signup',{email,password,full_name:fullName},null);
      if(!transitions.current(version)) return {error:'This sign-up was cancelled.',needsConfirmation:false};
      await transitions.establish(version,result);
      return {error:transitions.current(version)?null:'This sign-up was cancelled.',needsConfirmation:false};
    } catch(error) {
      await transitions.settle(version).catch(()=>{});
      return {error:error instanceof Error?error.message:'Could not create your account.',needsConfirmation:false};
    }
  },[transitions]);

  const signOut=useCallback(()=>transitions.clear(),[transitions]);
  const refreshUser=useCallback(async()=> {
    const active=transitions.activeSnapshot();
    if(!active) return;
    const version=transitions.capture();
    const me=await api.get<{user:AuthUser}>('/api/me',active.token);
    if(transitions.current(version)) await transitions.establish(version,{user:me.user,token:active.token});
  },[transitions]);
  const signOutAll=useCallback(async()=> {
    const active=transitions.activeSnapshot();
    if(!active) return;
    const version=transitions.capture();
    await api.post('/api/auth/signout-all',{},active.token);
    await transitions.clearIfCurrent(version,active.token);
  },[transitions]);
  const changePassword=useCallback(async(currentPassword:string,password:string)=> {
    const active=transitions.activeSnapshot();
    if(!active) throw new Error('Sign in to change your password.');
    const version=transitions.capture();
    await api.post('/api/auth/password/change',{currentPassword,password},active.token);
    await transitions.clearIfCurrent(version,active.token);
  },[transitions]);
  const resetPassword=useCallback(async(token:string,password:string)=> {
    const active=transitions.activeSnapshot();
    const version=transitions.capture();
    await api.post('/api/auth/password-reset/confirm',{token,password},null);
    if(active) await transitions.clearIfCurrent(version,active.token);
  },[transitions]);
  const value=useMemo(()=>({session,user:session?.user ?? null,loading,signIn,signUp,signOut,refreshUser,signOutAll,changePassword,resetPassword}),
    [session,loading,signIn,signUp,signOut,refreshUser,signOutAll,changePassword,resetPassword]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value=useContext(AuthContext);
  if(!value) throw new Error('useAuth must be used inside an AuthProvider.');
  return value;
}
