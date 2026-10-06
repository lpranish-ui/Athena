// Progress dashboard — overall accuracy, weak areas by topic, accuracy by
// book and recent attempts. Answers are attributed per question, so the
// weakest topics sort to the top.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Card, EmptyState, LoadingView } from '@/components/ui';
import { getProgress, type ProgressSummary } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { colors, fontSize, radius } from '@/theme';

function tone(accuracy: number): string {
  if (accuracy < 0.6) return colors.danger;
  if (accuracy < 0.8) return colors.warning;
  return colors.success;
}

function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function Bar({ accuracy }: { accuracy: number }) {
  const percent = Math.max(2, Math.round(accuracy * 100));
  return (
    <View style={styles.barBg}>
      <View style={[styles.barFill, { width: `${percent}%`, backgroundColor: tone(accuracy) }]} />
    </View>
  );
}

export default function ProgressScreen() {
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setSummary(await getProgress());
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading) {
    return <LoadingView label="Crunching your results…" />;
  }

  const totals = summary?.totals;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Progress' }} />
      {!summary || !totals || totals.attempts === 0 ? (
        <EmptyState
          icon="stats-chart-outline"
          title="No data yet"
          message="Finish a quiz and your accuracy by topic and book shows up here — including the areas that deserve another pass."
        />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
          <View style={styles.statRow}>
            <Card style={styles.statCard}>
              <Text style={[styles.statValue, { color: tone(totals.accuracy) }]}>
                {Math.round(totals.accuracy * 100)}%
              </Text>
              <Text style={styles.statLabel}>accuracy</Text>
            </Card>
            <Card style={styles.statCard}>
              <Text style={styles.statValue}>{totals.answered}</Text>
              <Text style={styles.statLabel}>answered</Text>
            </Card>
            <Card style={styles.statCard}>
              <Text style={styles.statValue}>{formatMinutes(totals.seconds)}</Text>
              <Text style={styles.statLabel}>quiz time</Text>
            </Card>
          </View>

          <Text style={styles.sectionTitle}>Weak areas</Text>
          {summary.topics.length === 0 ? (
            <Card style={styles.hintCard}>
              <Text style={styles.hintText}>
                Answer a few more questions — once topics have a couple of results, the weakest ones
                appear here.
              </Text>
            </Card>
          ) : (
            <Card style={styles.listCard}>
              {summary.topics.map((topic) => (
                <View key={topic.topic} style={styles.row}>
                  <View style={styles.rowHeader}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {topic.topic}
                    </Text>
                    <Text style={[styles.rowPct, { color: tone(topic.accuracy) }]}>
                      {Math.round(topic.accuracy * 100)}%
                    </Text>
                  </View>
                  <Bar accuracy={topic.accuracy} />
                  <Text style={styles.rowMeta}>
                    {topic.correct} of {topic.answered} correct
                  </Text>
                </View>
              ))}
            </Card>
          )}

          <Text style={styles.sectionTitle}>By book</Text>
          <Card style={styles.listCard}>
            {summary.books.map((book) => (
              <View key={book.book_title} style={styles.row}>
                <View style={styles.rowHeader}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {book.book_title}
                  </Text>
                  <Text style={[styles.rowPct, { color: tone(book.accuracy) }]}>
                    {Math.round(book.accuracy * 100)}%
                  </Text>
                </View>
                <Bar accuracy={book.accuracy} />
                <Text style={styles.rowMeta}>
                  {book.attempts} attempt{book.attempts === 1 ? '' : 's'} · {book.correct} of{' '}
                  {book.answered} correct
                </Text>
              </View>
            ))}
          </Card>

          <Text style={styles.sectionTitle}>Recent attempts</Text>
          <Card style={styles.listCard}>
            {summary.recent.map((attempt, index) => {
              const ok = attempt.score / Math.max(1, attempt.total) >= 0.6;
              return (
                <View key={`${attempt.completed_at ?? 'a'}-${index}`} style={styles.recentRow}>
                  <Ionicons
                    name={ok ? 'checkmark-circle' : 'alert-circle'}
                    size={18}
                    color={ok ? colors.success : colors.danger}
                  />
                  <View style={styles.recentText}>
                    <Text style={styles.recentTitle} numberOfLines={1}>
                      {attempt.set_title ?? 'Quiz'}
                    </Text>
                    <Text style={styles.recentMeta} numberOfLines={1}>
                      {attempt.book_title ? `${attempt.book_title} · ` : ''}
                      {attempt.mode === 'exam' ? 'Exam' : 'Tutor'}
                      {attempt.completed_at ? ` · ${formatRelative(attempt.completed_at)}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.recentScore}>
                    {attempt.score}/{attempt.total}
                  </Text>
                </View>
              );
            })}
          </Card>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, gap: 10 },
  statRow: { flexDirection: 'row', gap: 8 },
  statCard: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 14 },
  statValue: { color: colors.text, fontSize: fontSize.lg, fontWeight: '800' },
  statLabel: { color: colors.textMuted, fontSize: fontSize.xs },
  sectionTitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 10,
  },
  hintCard: { padding: 14 },
  hintText: { color: colors.textMuted, lineHeight: 20 },
  listCard: { gap: 14, paddingVertical: 16 },
  row: { gap: 6 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rowName: { color: colors.text, fontWeight: '600', flex: 1 },
  rowPct: { fontWeight: '800' },
  rowMeta: { color: colors.textMuted, fontSize: fontSize.xs },
  barBg: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: radius.pill },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  recentText: { flex: 1, gap: 1 },
  recentTitle: { color: colors.text, fontWeight: '600' },
  recentMeta: { color: colors.textMuted, fontSize: fontSize.xs },
  recentScore: { color: colors.text, fontWeight: '800' },
});
