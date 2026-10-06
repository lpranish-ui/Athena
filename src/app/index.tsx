import { Redirect } from 'expo-router';

import { LoadingView } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function Index() {
  const { session, loading } = useAuth();

  if (loading) {
    return <LoadingView />;
  }

  return <Redirect href={session ? '/today' : '/sign-in'} />;
}
