// Smart review — spaced repetition session. Questions you missed (or that are
// due again) come back until they stick; each answer reschedules the question.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { scheduleReview } from '@/lib/review';
import { supabase } from '@/lib/supabase';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { Mcq, Review } from '@/types';

const LETTERS = 'ABCDEFGH';
const REVIEW_BATCH = 20;

interface DueRow extends Review {
  question: Mcq | null;
}

export default function ReviewScreen() {
  const router = useRouter();

  const [queue, setQueue] = useState<DueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [stats, setStats] = useState({ correct: 0, total: 0 });

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('reviews')
      .select('*, question:mcqs(*)')
      .lte('due_at', new Date().toISOString())
      .order('due_at', { ascending: true })
      .limit(REVIEW_BATCH);

    if (loadError) {
      setError(loadError.message);
    }
    setQueue(((data ?? []) as unknown as DueRow[]).filter((row) => row.question));
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const current = queue[index];
  const revealed = selected !== null;

  const choose = async (optionIndex: number) => {
    if (revealed || !current?.question) return;

    const correct = optionIndex === current.question.correct_index;
    setSelected(optionIndex);
    setStats((previous) => ({
      correct: previous.correct + (correct ? 1 : 0),
      total: previous.total + 1,
    }));

    // Reschedule this question (best effort — never blocks the review).
    try {
      const schedule = scheduleReview(current, correct);
      await supabase
        .from('reviews')
        .upsert(
          { user_id: current.user_id, question_id: current.question_id, ...schedule },
          { onConflict: 'user_id,question_id' },
        );
    } catch {
      // Ignore — reviewing continues regardless.
    }
  };

  const next = () => {
    setSelected(null);
    setIndex((value) => value + 1);
  };

  if (loading) {
    return <LoadingView label="Loading your review queue…" />;
  }

  if (queue.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Smart review' }} />
        <EmptyState
          icon="checkmark-done-outline"
          title="Nothing due right now"
          message="Miss a question in any quiz and it will come back here — first within hours, then days apart as it sticks."
          actionLabel="Back to quizzes"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  // ── Session summary ─────────────────────────────────────────────────────────
  if (index >= queue.length) {
    const pct =
      stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0;
    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: 'Smart review' }} />
        <ScrollView contentContainerStyle={styles.content}>
          <Card style={styles.summaryCard}>
            <Ionicons name="checkmark-done-circle" size={40} color={colors.primary} />
            <Text style={styles.summaryTitle}>Review complete</Text>
            <Text style={styles.summaryScore}>
              {stats.correct} / {stats.total} correct ({pct}%)
            </Text>
            <Text style={styles.summaryText}>
              Remembered questions now wait longer before their next appearance; the ones you
              missed will come back soon.
            </Text>
            {stats.total < queue.length ? (
              <Text style={styles.summaryText}>
                {queue.length - stats.total} question{queue.length - stats.total === 1 ? '' : 's'}{' '}
                left in this session — they stay due, so just reopen review to finish them.
              </Text>
            ) : null}
            <Button label="Done" onPress={() => router.back()} />
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  // ── Question view ───────────────────────────────────────────────────────────
  const question = current.question as Mcq;
  const progress = ((index + 1) / queue.length) * 100;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Smart review' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.progressWrap}>
          <Text style={styles.progressText}>
            Review {index + 1} of {queue.length}
          </Text>
          <Text style={styles.progressScore}>
            {stats.correct} correct so far
          </Text>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        {question.topic ? <Badge label={question.topic} color={colors.accent} /> : null}
        <Text style={styles.questionText}>{question.question}</Text>

        <View style={styles.options}>
          {question.options.map((option, optionIndex) => {
            const isCorrect = optionIndex === question.correct_index;
            const isChosen = optionIndex === selected;
            const showCorrect = revealed && isCorrect;
            const showWrong = revealed && isChosen && !isCorrect;
            const dimmed = revealed && !isCorrect && !isChosen;

            return (
              <Pressable
                key={optionIndex}
                disabled={revealed}
                onPress={() => void choose(optionIndex)}
                style={({ pressed }) => [
                  styles.option,
                  dimmed && styles.optionDimmed,
                  showCorrect && styles.optionCorrect,
                  showWrong && styles.optionWrong,
                  pressed && !revealed && styles.optionPressed,
                ]}
              >
                <View
                  style={[
                    styles.letter,
                    showCorrect && styles.letterCorrect,
                    showWrong && styles.letterWrong,
                  ]}
                >
                  <Text
                    style={[
                      styles.letterText,
                      showCorrect && styles.letterTextCorrect,
                      showWrong && styles.letterTextWrong,
                    ]}
                  >
                    {LETTERS[optionIndex]}
                  </Text>
                </View>
                <Text style={styles.optionText}>{option}</Text>
                {showCorrect ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                ) : null}
                {showWrong ? (
                  <Ionicons name="close-circle" size={20} color={colors.danger} />
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {revealed ? (
          <Card style={styles.explanationCard}>
            <View style={styles.explanationHeader}>
              <Ionicons
                name={selected === question.correct_index ? 'checkmark-circle' : 'information-circle'}
                size={18}
                color={selected === question.correct_index ? colors.success : colors.warning}
              />
              <Text style={styles.explanationTitle}>
                {selected === question.correct_index ? 'Correct!' : 'Not quite'}
              </Text>
            </View>
            {question.explanation ? (
              <Text style={styles.explanation}>{question.explanation}</Text>
            ) : null}
            {question.source_page || question.supporting_quote ? (
              <View style={styles.citation}>
                <Ionicons name="book-outline" size={15} color={colors.accent} />
                <View style={styles.citationBody}>
                  {question.source_page ? (
                    <Text style={styles.citationPage}>From page {question.source_page}</Text>
                  ) : null}
                  {question.supporting_quote ? (
                    <Text style={styles.citationQuote}>“{question.supporting_quote}”</Text>
                  ) : null}
                </View>
              </View>
            ) : null}
          </Card>
        ) : (
          <Text style={styles.pickHint}>Pick the best answer.</Text>
        )}

        <Button label={index + 1 >= queue.length ? 'Finish review' : 'Next question'} onPress={next} disabled={!revealed} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 20,
    paddingBottom: 48,
    gap: spacing.md,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  progressWrap: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  progressScore: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  questionText: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 25,
    fontWeight: '600',
  },
  options: {
    gap: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  optionDimmed: {
    opacity: 0.55,
  },
  optionCorrect: {
    backgroundColor: withAlpha(colors.success, '14'),
    borderColor: colors.success,
  },
  optionWrong: {
    backgroundColor: withAlpha(colors.danger, '14'),
    borderColor: colors.danger,
  },
  optionPressed: {
    borderColor: colors.primary,
  },
  letter: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  letterCorrect: {
    backgroundColor: withAlpha(colors.success, '33'),
  },
  letterWrong: {
    backgroundColor: withAlpha(colors.danger, '33'),
  },
  letterText: {
    fontWeight: '800',
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  letterTextCorrect: {
    color: colors.success,
  },
  letterTextWrong: {
    color: colors.danger,
  },
  optionText: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  explanationCard: {
    gap: spacing.sm,
    borderColor: withAlpha(colors.primary, '44'),
  },
  explanationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  explanationTitle: {
    color: colors.text,
    fontWeight: '800',
    fontSize: fontSize.md,
  },
  explanation: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 21,
  },
  citation: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    backgroundColor: withAlpha(colors.accent, '10'),
    borderWidth: 1,
    borderColor: withAlpha(colors.accent, '33'),
    borderRadius: radius.md,
    padding: 10,
  },
  citationBody: {
    flex: 1,
    gap: 2,
  },
  citationPage: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  citationQuote: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  pickHint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
  summaryCard: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xl,
  },
  summaryTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  summaryScore: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  summaryText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
});
