// Shown when the app starts without the API URL configured.

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
          Athena talks to its own API server for accounts, books and quizzes. Create a{' '}
          <Text style={styles.code}>.env</Text> file in the project root (copy{' '}
          <Text style={styles.code}>.env.example</Text>) and fill in:
        </Text>
        <Card style={styles.codeCard}>
          <Text style={styles.codeText}>
            EXPO_PUBLIC_API_URL=https://athena-api-w018.onrender.com
          </Text>
        </Card>
        <Text style={styles.body}>
          The API lives in <Text style={styles.code}>server/</Text> (Node + Postgres, deployed on
          Render). Restart the dev server after saving <Text style={styles.code}>.env</Text> so it
          gets picked up.
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
