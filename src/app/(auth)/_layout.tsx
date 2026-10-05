import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/lib/auth';
import { colors } from '@/theme';

export default function AuthLayout() {
  const { session } = useAuth();

  if (session) {
    return <Redirect href="/library" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
