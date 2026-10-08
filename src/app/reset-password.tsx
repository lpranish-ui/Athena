import {Link,router,useLocalSearchParams} from 'expo-router';
import {useEffect,useState} from 'react';
import {Text} from 'react-native';
import {AccountForm,accountStyles} from '@/components/AccountForm';
import {Button,ErrorBanner,Input} from '@/components/ui';
import {useAuth} from '@/lib/auth';

export default function ResetPassword() {
  const params=useLocalSearchParams<{token?:string}>();
  const [token]=useState(()=>typeof params.token==='string'?params.token:'');
  const [password,setPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const {resetPassword}=useAuth();
  // Retain the link only in component memory, removing it from the visible URL.
  useEffect(()=> {if(params.token) router.setParams({token:undefined});},[params.token]);
  const submit=async()=> {
    if(busy) return;
    if(password.length<8) {setError('Use at least 8 characters.');return;}
    if(password!==confirm) {setError('The passwords do not match.');return;}
    setBusy(true);setError(null);
    try {
      await resetPassword(token,password);
      setPassword('');setConfirm('');setDone(true);
    } catch(error) {setError(error instanceof Error?error.message:'Could not reset your password.');}
    finally {setBusy(false);}
  };
  return <AccountForm title={done?'Password updated':'Choose a new password'} description={done?'Your previous sessions have been signed out. Sign in with your new password to keep learning.':'Choose a password you do not use elsewhere. This link can be used once.'}>
    {error?<ErrorBanner message={error}/>:null}
    {!token && !done?<ErrorBanner message="Open the complete link from your reset email. If it expired, request a new link."/>:null}
    {!done && token?<>
      <Input label="New password" value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword"/>
      <Input label="Repeat new password" value={confirm} onChangeText={setConfirm} secureTextEntry textContentType="newPassword" onSubmitEditing={()=>void submit()}/>
      <Button label="Update password" onPress={()=>void submit()} loading={busy}/>
    </>:null}
    {done?<Text style={accountStyles.message}>Your password was changed successfully.</Text>:null}
    <Link href="/sign-in" style={accountStyles.link}>Sign in</Link>
    {!done?<Link href="/forgot-password" style={accountStyles.link}>Request another reset link</Link>:null}
  </AccountForm>;
}
