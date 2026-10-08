import {Link} from 'expo-router';
import {useState} from 'react';
import {Text} from 'react-native';
import {AccountForm,accountStyles} from '@/components/AccountForm';
import {Button,ErrorBanner,Input} from '@/components/ui';
import {api} from '@/lib/apiClient';

export default function ForgotPassword() {
  const [email,setEmail]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const submit=async()=> {
    if(busy) return;
    if(!email.trim()) {setError('Enter the email you used for Athena.');return;}
    setBusy(true);setError(null);setMessage(null);
    try {const result=await api.post<{message:string}>('/api/auth/password-reset/request',{email:email.trim()},null);setMessage(result.message);}
    catch(error) {setError(error instanceof Error?error.message:'Password reset is currently unavailable. Please try again later.');}
    finally {setBusy(false);}
  };
  return <AccountForm title="Reset your password" description="Enter your account email to request a secure link. The link expires after 30 minutes.">
    {error?<ErrorBanner message={error}/>:null}
    {message?<Text style={accountStyles.message}>{message}</Text>:null}
    <Input label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} textContentType="emailAddress" onSubmitEditing={()=>void submit()}/>
    <Button label="Request reset link" onPress={()=>void submit()} loading={busy}/>
    <Text style={accountStyles.body}>If email delivery is unavailable, this page will tell you. It will never display a private reset link.</Text>
    <Link href="/sign-in" style={accountStyles.link}>Back to sign in</Link>
  </AccountForm>;
}
