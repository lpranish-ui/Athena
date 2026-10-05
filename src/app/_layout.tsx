import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { SetupScreen } from '@/components/SetupScreen';
import { LoadingView } from '@/components/ui';
import { isApiConfigured } from '@/lib/apiClient';
import { AuthProvider, useAuth } from '@/lib/auth';
import { colors } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.primary,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
};

const headerOptions = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: '700' as const },
  headerShadowVisible: false,
};

export default function RootLayout() {
  return (
    <ThemeProvider value={navigationTheme}>
      <AuthProvider>
        <StatusBar style="light" />
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}

function RootNavigator() {
  const { loading } = useAuth();

  useEffect(() => {
    if (!loading) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [loading]);

  if (!isApiConfigured) {
    return <SetupScreen />;
  }

  if (loading) {
    return <LoadingView label="Waking up Athena…" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen
        name="upload"
        options={{ ...headerOptions, presentation: 'modal', title: 'Add a book' }}
      />
      <Stack.Screen name="book/[id]" options={{ ...headerOptions, title: 'Book' }} />
      <Stack.Screen name="chapter/[id]" options={{ ...headerOptions, title: 'Chapter' }} />
      <Stack.Screen name="quiz/[id]" options={{ ...headerOptions, title: 'Quiz' }} />
      <Stack.Screen
        name="manage-chapters"
        options={{ ...headerOptions, title: 'Fix chapters' }}
      />
      <Stack.Screen name="generate" options={{ ...headerOptions, title: 'Build a quiz' }} />
      <Stack.Screen name="review" options={{ ...headerOptions, title: 'Smart review' }} />
      <Stack.Screen name="flashcards" options={{ ...headerOptions, title: 'Flashcards' }} />
      <Stack.Screen name="summary" options={{ ...headerOptions, title: 'Chapter summary' }} />
      <Stack.Screen name="mock-exam" options={{ ...headerOptions, title: 'Mock exam' }} />
      <Stack.Screen name="group" options={{ ...headerOptions, title: 'Group study' }} />
      <Stack.Screen name="group/[code]" options={{ ...headerOptions, title: 'Group game' }} />
    </Stack>
  );
}
