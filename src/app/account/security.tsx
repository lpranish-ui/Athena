import {useState} from 'react';
import {Text,View} from 'react-native';
import {AccountForm,accountStyles} from '@/components/AccountForm';
import {Button,Card,ErrorBanner,Input} from '@/components/ui';
import {api} from '@/lib/apiClient';
import {useAuth} from '@/lib/auth';
import {spacing} from '@/theme';

export default function AccountSecurity() {
  const {user,session,changePassword,signOutAll,refreshUser}=useAuth();
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const [currentPassword,setCurrentPassword]=useState('');
  const [password,setPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [revokeConfirm,setRevokeConfirm]=useState(false);
  const run=async(key:string,operation:()=>Promise<void>)=> {
    if(busy) return;
    setBusy(key);setError(null);setMessage(null);
    try {await operation();}
    catch(error) {setError(error instanceof Error?error.message:'Could not update account security.');}
    finally {setBusy(null);}
  };
  const verify=()=>run('verify',async()=> {
    const result=await api.post<{message:string}>('/api/auth/verification/request',{},session?.token);
    setMessage(result.message);
  });
  const change=()=>run('password',async()=> {
    if(password.length<8) throw new Error('Use at least 8 characters for your new password.');
    if(password!==confirm) throw new Error('The new passwords do not match.');
    await changePassword(currentPassword,password);
    setCurrentPassword('');setPassword('');setConfirm('');
  });
  return <AccountForm title="Account security" description="Manage your email, password and sessions. Your private downloads are removed from this device when you sign out.">
    {error?<ErrorBanner message={error}/>:null}
    {message?<Text style={accountStyles.message}>{message}</Text>:null}
    <Card style={{gap:spacing.md}}><Text style={accountStyles.body}>{user?.email}</Text>
      <Text style={accountStyles.body}>{user?.email_verified?'Email verified':'Email not yet verified'}</Text>
      {!user?.email_verified?<Button label="Send verification email" variant="secondary" onPress={()=>void verify()} loading={busy==='verify'} disabled={!!busy}/>:null}
      <Button label="Refresh verification status" variant="ghost" onPress={()=>void run('refresh',refreshUser)} loading={busy==='refresh'} disabled={!!busy}/>
    </Card>
    <Card style={{gap:spacing.md}}><Text style={accountStyles.body}>Changing your password signs out every device, including this one.</Text>
      <Input label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry textContentType="password"/>
      <Input label="New password" value={password} onChangeText={setPassword} secureTextEntry textContentType="newPassword"/>
      <Input label="Repeat new password" value={confirm} onChangeText={setConfirm} secureTextEntry textContentType="newPassword"/>
      <Button label="Change password and sign out" onPress={()=>void change()} loading={busy==='password'} disabled={!!busy}/>
    </Card>
    <Card style={{gap:spacing.md}}><Text style={accountStyles.body}>Sign out all devices if you used a shared computer or suspect someone has your session.</Text>
      {revokeConfirm?<View style={{gap:spacing.md}}><Text style={accountStyles.body}>This also signs out this device. Continue?</Text>
        <Button label="Confirm: sign out every device" variant="danger" onPress={()=>void run('revoke',signOutAll)} loading={busy==='revoke'} disabled={!!busy}/>
        <Button label="Cancel" variant="ghost" onPress={()=>setRevokeConfirm(false)} disabled={!!busy}/>
      </View>:<Button label="Sign out all devices" variant="secondary" onPress={()=>setRevokeConfirm(true)} disabled={!!busy}/>}
    </Card>
  </AccountForm>;
}
