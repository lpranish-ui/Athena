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
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    if (busy) return;
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
              A clear daily plan. Short lessons. Practice that helps yesterday’s learning stick.
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
            <Link href="/forgot-password" style={styles.link}>Forgot your password?</Link>
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>New to Athena? </Text>
            <Link href="/sign-up" style={styles.link}>
              Create an account
            </Link>
          </View>
          <Link href="/preview" style={[styles.link,{textAlign:"center"}]}>Try a lesson before signing up</Link>
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
});
