import { Link, useRouter } from 'expo-router';
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

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const onSubmit = async () => {
    if (!fullName.trim()) {
      setError('Tell us your name so your profile looks right.');
      return;
    }
    if (!email.trim() || !password) {
      setError('Enter an email and a password.');
      return;
    }
    if (password.length < 6) {
      setError('Use a password with at least 6 characters.');
      return;
    }

    setBusy(true);
    setError(null);
    const result = await signUp(email.trim(), password, fullName.trim());
    setBusy(false);

    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.needsConfirmation) {
      setConfirmationSent(true);
    }
    // Without email confirmation the (auth) layout signs the user straight in.
  };

  if (confirmationSent) {
    return (
      <Screen>
        <View style={styles.confirmWrap}>
          <Brand />
          <Text style={styles.confirmTitle}>Check your inbox</Text>
          <Text style={styles.confirmText}>
            We sent a confirmation link to <Text style={styles.bold}>{email.trim()}</Text>. Open
            it, then come back and sign in.
          </Text>
          <Button label="Back to sign in" onPress={() => router.replace('/sign-in')} />
        </View>
      </Screen>
    );
  }

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
              Create your account — your library stays private to you.
            </Text>
          </View>

          <View style={styles.form}>
            {error ? <ErrorBanner message={error} /> : null}
            <Input
              label="Full name"
              value={fullName}
              onChangeText={setFullName}
              placeholder="Jane Doe"
              autoCapitalize="words"
              textContentType="name"
            />
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
              placeholder="At least 6 characters"
              secureTextEntry
              textContentType="newPassword"
              onSubmitEditing={onSubmit}
            />
            <Button label="Create account" onPress={onSubmit} loading={busy} />
          </View>

          <View style={styles.footer}>
            <Text style={styles.footerText}>Already have an account? </Text>
            <Link href="/sign-in" style={styles.link}>
              Sign in
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
  confirmWrap: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.lg,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  confirmTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
  },
  confirmText: {
    color: colors.textMuted,
    fontSize: 15,
    lineHeight: 22,
  },
  bold: {
    color: colors.text,
    fontWeight: '700',
  },
});
