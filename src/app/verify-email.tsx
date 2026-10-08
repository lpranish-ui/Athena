import {Link,router,useLocalSearchParams} from 'expo-router';
import {useEffect,useState} from 'react';
import {Text} from 'react-native';
import {AccountForm,accountStyles} from '@/components/AccountForm';
import {Button,ErrorBanner} from '@/components/ui';
import {api} from '@/lib/apiClient';
import {useAuth} from '@/lib/auth';

export default function VerifyEmail() {
  const params=useLocalSearchParams<{token?:string}>();
  const [token]=useState(()=>typeof params.token==='string'?params.token:'');
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const {user,refreshUser}=useAuth();
  useEffect(()=> {if(params.token) router.setParams({token:undefined});},[params.token]);
  const submit=async()=> {
    if(busy) return;
    setBusy(true);setError(null);
    try {
      await api.post('/api/auth/verification/confirm',{token},null);
      setDone(true);
      if(user) await refreshUser().catch(()=>{});
    } catch(error) {setError(error instanceof Error?error.message:'Could not verify this email.');}
    finally {setBusy(false);}
  };
  return <AccountForm title={done?'Email verified':'Verify your email'} description={done?'Your email is now connected to your Athena account.':'Confirm that this email belongs to you. No password is needed.'}>
    {error?<ErrorBanner message={error}/>:null}
    {!token && !done?<ErrorBanner message="Open the complete verification link from your email. You can request another in Account security."/>:null}
    {token && !done?<Button label="Verify email" onPress={()=>void submit()} loading={busy}/>:null}
    {done?<Text style={accountStyles.message}>Verification completed successfully.</Text>:null}
    <Link href={user?'/account/security':'/sign-in'} style={accountStyles.link}>{user?'Back to account security':'Sign in'}</Link>
  </AccountForm>;
}
