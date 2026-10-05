import { Link } from 'expo-router';
import { useState } from 'react';
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { Brand } from '@/components/Brand';
import { Screen } from '@/components/Screen';
import { Button, ErrorBanner, Input } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { colors, spacing } from '@/theme';

export default function SignInScreen() {
  const { signIn, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password to continue.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await signIn(email.trim(), password);
    setBusy(false);
    if (result.error) {
      setError(result.error);
    }
    // On success the (auth) layout redirects to the app automatically.
  };

  const onGoogle = async () => {
    setBusy(true);
    setError(null);
    const result = await signInWithGoogle();
    setBusy(false);
    if (result.error) {
      setError(result.error);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Brand />
            <Text style={styles.tagline}>
              Turn any medical book into quizzes. Study smarter, one chapter at a time.
            </Text>
          </View>

          <View style={styles.form}>
            {error ? <ErrorBanner message={error} /> : null}
            <Input
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@medschool.edu"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
            />
            <Input
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              secureTextEntry
              textContentType="password"
              onSubmitEditing={onSubmit}
            />
            <Button label="Sign in" onPress={onSubmit} loading={busy} />
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>
            <Button
              label="Continue with Google"
              variant="secondary"
              icon="logo-google"
              onPress={() => void onGoogle()}
              loading={busy}
            />
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>New to Athena? </Text>
            <Link href="/sign-up" style={styles.link}>
              Create an account
            </Link>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.xl,
    paddingVertical: spacing.xl,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  hero: {
    gap: spacing.md,
  },
  tagline: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
  },
  form: {
    gap: spacing.md,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  footerText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  link: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '700',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerText: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
