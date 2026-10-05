// Shown when the app starts without Supabase environment variables configured.

import { StyleSheet, Text, View } from 'react-native';

import { Brand } from '@/components/Brand';
import { Screen } from '@/components/Screen';
import { Card } from '@/components/ui';
import { colors, fontSize, spacing } from '@/theme';

export function SetupScreen() {
  return (
    <Screen>
      <View style={styles.wrap}>
        <Brand />
        <Text style={styles.title}>Almost there…</Text>
        <Text style={styles.body}>
          Athena needs a Supabase project to store accounts, books and quizzes. Create a{' '}
          <Text style={styles.code}>.env</Text> file in the project root (copy{' '}
          <Text style={styles.code}>.env.example</Text>) and fill in:
        </Text>
        <Card style={styles.codeCard}>
          <Text style={styles.codeText}>
            EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co{'\n'}
            EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
          </Text>
        </Card>
        <Text style={styles.body}>
          Then run the SQL files in <Text style={styles.code}>supabase/migrations/</Text> (then{' '}
          <Text style={styles.code}>supabase/seed.sql</Text>) in your Supabase project’s SQL
          Editor, deploy the edge functions, and restart the app.
        </Text>
        <Text style={styles.body}>The full walkthrough is in README.md.</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'center',
    gap: spacing.md,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  body: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 22,
  },
  code: {
    color: colors.primary,
    fontWeight: '700',
  },
  codeCard: {
    backgroundColor: colors.surfaceAlt,
  },
  codeText: {
    color: colors.accent,
    fontSize: fontSize.xs,
    lineHeight: 20,
  },
});
