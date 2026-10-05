// Authentication state for the whole app.

import type { Session, User } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import { Platform } from 'react-native';

import { isSupabaseConfigured, supabase } from './supabase';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
  ) => Promise<{ error: string | null; needsConfirmation: boolean }>;
  signOut: () => Promise<void>;
}

/** Extracts OAuth callback parameters from a deep-link URL (fragment or query). */
function parseAuthCallback(url: string): Record<string, string> {
  const hashIndex = url.indexOf('#');
  const queryIndex = url.indexOf('?');
  const raw =
    hashIndex >= 0 ? url.slice(hashIndex + 1) : queryIndex >= 0 ? url.slice(queryIndex + 1) : '';
  const params: Record<string, string> = {};
  for (const pair of raw.split('&')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    params[decodeURIComponent(pair.slice(0, separator))] = decodeURIComponent(
      pair.slice(separator + 1),
    );
  }
  return params;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  // Nothing to load when Supabase isn't configured yet.
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!isSupabaseConfigured) return;

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error ? error.message : null };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const isWeb = Platform.OS === 'web';

    // Web: Supabase redirects the current tab. Mobile: open the provider in a
    // secure in-app browser and capture the deep-link callback ourselves.
    const redirectTo = isWeb
      ? (globalThis as { location?: { origin?: string } }).location?.origin
      : Linking.createURL('/');

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        ...(redirectTo ? { redirectTo } : {}),
        skipBrowserRedirect: !isWeb,
      },
    });

    if (error) return { error: error.message };
    if (isWeb) return { error: null };

    if (!data?.url || !redirectTo) {
      return { error: 'Could not start Google sign-in.' };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success' || !result.url) {
      return { error: null }; // the student cancelled
    }

    const params = parseAuthCallback(result.url);
    if (params.error_description) return { error: params.error_description };
    if (!params.access_token || !params.refresh_token) {
      return {
        error:
          'Google sign-in did not return a session. Check the redirect URLs in your Supabase auth settings.',
      };
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: params.access_token,
      refresh_token: params.refresh_token,
    });
    return { error: sessionError ? sessionError.message : null };
  }, []);

  const signUp = useCallback(async (email: string, password: string, fullName: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) return { error: error.message, needsConfirmation: false };
    // When email confirmation is switched on, Supabase returns no session.
    return { error: null, needsConfirmation: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      signIn,
      signInWithGoogle,
      signUp,
      signOut,
    }),
    [session, loading, signIn, signInWithGoogle, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}
