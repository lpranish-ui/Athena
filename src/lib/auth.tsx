// Authentication state for the whole app (backed by the Athena API).

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

import { api, apiRequest, ApiError, isApiConfigured, loadStoredUser, loadToken, saveStoredUser, saveToken } from './apiClient';

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
}

interface AuthContextValue {
  session: AuthSession | null;
  user: AuthUser | null;
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

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  // Nothing to load when the API isn't configured yet.
  const [loading, setLoading] = useState(isApiConfigured);
  const sessionVersion = useRef(0);

  useEffect(() => {
    if (!isApiConfigured) return;

    let mounted = true;
    const version = sessionVersion.current;
    const current = () => mounted && version === sessionVersion.current;

    (async () => {
      try {
        const token = await loadToken();
        if (!token) return;

        // Open optimistically with the stored user, then validate in the
        // background so the app also works with a flaky connection.
        const storedUser = await loadStoredUser();
        if (!current()) return;
        if (storedUser) {
          setSession({ user: storedUser, token });
          // Cached identity is enough to open the app; validation runs in the background.
          setLoading(false);
        }

        try {
          const me = await apiRequest<{ user: AuthUser }>('GET', '/api/me', {
            token,
            timeoutMs: 10000,
          });
          if (!current()) return;
          setSession({ user: me.user, token });
          await saveStoredUser(me.user);
        } catch (error) {
          if (current() && error instanceof ApiError && error.status === 401) {
            // The token expired or the account was deleted — sign out.
            await saveToken(null);
            await saveStoredUser(null);
            if (current()) setSession(null);
          }
          // Network errors: keep the stored session; the API retries later.
        }
      } catch {
        // A damaged/unavailable storage provider must not trap the app on its splash screen.
        if (current()) setSession(null);
      } finally {
        if (current()) setLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    sessionVersion.current += 1;
    try {
      const result = await api.post<{ token: string; user: AuthUser }>(
        '/api/auth/signin',
        { email, password },
        null,
      );
      await saveToken(result.token);
      await saveStoredUser(result.user);
      setSession({ user: result.user, token: result.token });
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Could not sign you in.' };
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    // Google sign-in will be wired to the API in a later update.
    return {
      error:
        'Google sign-in is coming in a later update. Please use your email and password for now.',
    };
  }, []);

  const signUp = useCallback(async (email: string, password: string, fullName: string) => {
    sessionVersion.current += 1;
    try {
      const result = await api.post<{ token: string; user: AuthUser; needsConfirmation?: boolean }>(
        '/api/auth/signup',
        { email, password, full_name: fullName },
        null,
      );
      await saveToken(result.token);
      await saveStoredUser(result.user);
      setSession({ user: result.user, token: result.token });
      return { error: null, needsConfirmation: result.needsConfirmation ?? false };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Could not create your account.',
        needsConfirmation: false,
      };
    }
  }, []);

  const signOut = useCallback(async () => {
    sessionVersion.current += 1;
    await saveToken(null);
    await saveStoredUser(null);
    setSession(null);
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
