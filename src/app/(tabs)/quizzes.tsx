import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, EmptyState, ErrorBanner } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { formatRelative, percentage } from '@/lib/format';
import { colors, fontSize, spacing, withAlpha } from '@/theme';
import type { Difficulty, McqSetWithContext } from '@/types';

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  easy: colors.success,
  medium: colors.warning,
  hard: colors.danger,
};

export default function QuizzesScreen() {
  const router = useRouter();
  const [sets, setSets] = useState<McqSetWithContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dueCount, setDueCount] = useState(0);
  const [planner, setPlanner] = useState<{
    examLabel: string;
    daysLeft: number;
    todayAnswered: number;
    chaptersTotal: number;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [setsData, plannerData] = await Promise.all([
        api.get<McqSetWithContext[]>('/api/sets'),
        api.get<{
          dueCount: number;
          totalChapters: number;
          examDate: string | null;
          targetExam: string | null;
          attempts: { completed_at: string; score: number; total: number }[];
        }>('/api/planner'),
      ]);

      setError(null);
      setSets(setsData);
      setDueCount(plannerData.dueCount);

      if (plannerData.examDate) {
        const daysLeft = Math.ceil(
          (new Date(`${plannerData.examDate}T00:00:00`).getTime() - Date.now()) / 86_400_000,
        );
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayAnswered = plannerData.attempts
          .filter((attempt) => new Date(attempt.completed_at).getTime() >= todayStart.getTime())
          .reduce((sum, attempt) => sum + (attempt.total ?? 0), 0);
        setPlanner({
          examLabel: plannerData.targetExam ?? 'your exam',
          daysLeft,
          todayAnswered,
          chaptersTotal: plannerData.totalChapters,
        });
      } else {
        setPlanner(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your quizzes.');
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen padded={false}>
      <FlatList
        data={sets}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>Quizzes</Text>
            <Text style={styles.subtitle}>AI-generated from your chapters</Text>
            {error ? <ErrorBanner message={error} style={styles.error} /> : null}
            {planner ? (
              <View style={[styles.reviewCard, styles.planCard]}>
                <Ionicons name="calendar-outline" size={20} color={colors.accent} />
                <View style={styles.reviewText}>
                  <Text style={styles.reviewTitle}>
                    {planner.daysLeft >= 0
                      ? `${planner.daysLeft} days to ${planner.examLabel}`
                      : `${planner.examLabel} date has passed — update it in Profile`}
                  </Text>
                  <Text style={styles.reviewMeta}>
                    Today: {planner.todayAnswered} questions answered
                    {planner.daysLeft > 0 && planner.chaptersTotal > 0
                      ? ` · aim for ~${Math.max(
                          1,
                          Math.ceil(planner.chaptersTotal / planner.daysLeft),
                        )} chapters/day`
                      : ''}
                  </Text>
                </View>
              </View>
            ) : null}
            {dueCount > 0 ? (
              <Pressable
                style={({ pressed }) => [styles.reviewCard, pressed && styles.pressed]}
                onPress={() => router.push('/review')}
              >
                <Ionicons name="repeat-outline" size={20} color={colors.primary} />
                <View style={styles.reviewText}>
                  <Text style={styles.reviewTitle}>Smart review</Text>
                  <Text style={styles.reviewMeta}>
                    {dueCount} question{dueCount === 1 ? '' : 's'} due — bring them back until they
                    stick
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.reviewCard, pressed && styles.pressed]}
              onPress={() => router.push('/mock-exam')}
            >
              <Ionicons name="timer-outline" size={20} color={colors.primary} />
              <View style={styles.reviewText}>
                <Text style={styles.reviewTitle}>Mock exam</Text>
                <Text style={styles.reviewMeta}>
                  A timed run across a book’s chapters, built from your questions
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.reviewCard, pressed && styles.pressed]}
              onPress={() => router.push('/group')}
            >
              <Ionicons name="people-outline" size={20} color={colors.accent} />
              <View style={styles.reviewText}>
                <Text style={styles.reviewTitle}>Group study</Text>
                <Text style={styles.reviewMeta}>
                  Quiz your friends live — same questions, fastest correct answers win
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : (
            <EmptyState
              icon="help-circle-outline"
              title="No quizzes yet"
              message="Open any chapter and tap “Generate MCQs” — DeepSeek will write a quiz from the chapter text for you."
              actionLabel="Browse the library"
              onAction={() => router.navigate('/library')}
            />
          )
        }
        renderItem={({ item }) => {
          const attempts = item.attempts ?? [];
          const best = attempts.length
            ? Math.max(...attempts.map((attempt) => percentage(attempt.score, attempt.total)))
            : null;
          const difficulty = (item.difficulty ?? 'medium') as Difficulty;

          return (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
              onPress={() => router.push({ pathname: '/quiz/[id]', params: { id: item.id } })}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {item.title ?? 'Quiz'}
                </Text>
                <Badge
                  label={difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}
                  color={DIFFICULTY_COLORS[difficulty]}
                />
              </View>

              <Text style={styles.cardMeta} numberOfLines={1}>
                {item.chapter?.book?.title ?? 'Unknown book'}
                {item.chapter ? ` · Ch. ${item.chapter.number} — ${item.chapter.title}` : ''}
              </Text>

              <View style={styles.cardFooter}>
                <Text style={styles.cardSmall}>
                  {attempts.length} attempt{attempts.length === 1 ? '' : 's'} ·{' '}
                  {formatRelative(item.created_at)}
                </Text>
                {best !== null ? (
                  <View
                    style={[
                      styles.scoreChip,
                      {
                        backgroundColor: withAlpha(
                          best >= 70 ? colors.success : colors.warning,
                          '22',
                        ),
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.scoreText,
                        { color: best >= 70 ? colors.success : colors.warning },
                      ]}
                    >
                      Best {best}%
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.cardSmall}>Not attempted</Text>
                )}
              </View>
            </Pressable>
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: 20,
    gap: 12,
    paddingBottom: 48,
  },
  header: {
    gap: 2,
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
  },
  error: {
    marginTop: spacing.sm,
  },
  reviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: withAlpha(colors.primary, '12'),
    borderWidth: 1,
    borderColor: withAlpha(colors.primary, '55'),
    borderRadius: 18,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  planCard: {
    backgroundColor: withAlpha(colors.accent, '12'),
    borderColor: withAlpha(colors.accent, '55'),
  },
  reviewText: {
    flex: 1,
    gap: 2,
  },
  reviewTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  reviewMeta: {
    color: colors.textMuted,
    fontSize: 12,
  },
  spinner: {
    marginTop: 48,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    padding: spacing.md,
    gap: spacing.sm,
  },
  pressed: {
    opacity: 0.88,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cardTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  cardMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardSmall: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  scoreChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  scoreText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
});
