// Quiz player — Tutor mode (feedback after each question) and Exam mode
// (answers recorded first, results at the end). Every question shows the page
// it came from + a supporting quote, per-option explanations, and a report
// control that hides bad questions for this student.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { useQuizClock } from '@/hooks/useQuizClock';
import { flagQuestion, replaceQuestion } from '@/lib/api';
import { api } from '@/lib/apiClient';
import { isClozeCorrect } from '@/lib/cloze';
import { percentage } from '@/lib/format';
import { scheduleReview } from '@/lib/review';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { FlagReason, Mcq, McqSetWithContext, QuizMode } from '@/types';

const LETTERS = 'ABCDEFGH';

const REASON_OPTIONS: { label: string; value: FlagReason }[] = [
  { label: 'Incorrect', value: 'incorrect' },
  { label: 'Unclear', value: 'unclear' },
  { label: 'Duplicate', value: 'duplicate' },
  { label: 'Other', value: 'other' },
];

const TYPE_LABELS: Record<string, string> = {
  single_best_answer: 'Standard MCQs',
  vignette: 'Clinical vignettes',
  true_false: 'True / False',
  cloze: 'Cloze (fill-in-the-blank)',
};

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** Report-a-problem control, used both during the quiz and in the review. */
function ReportControl({ questionId }: { questionId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<FlagReason>('incorrect');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<'idle' | 'busy' | 'done'>('idle');
  const [replacementError, setReplacementError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await flagQuestion({ questionId, reason });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the report.');
    } finally {
      setBusy(false);
    }
  };

  const getReplacement = async () => {
    setReplacement('busy');
    setReplacementError(null);
    try {
      await replaceQuestion(questionId);
      setReplacement('done');
    } catch (err) {
      setReplacement('idle');
      setReplacementError(
        err instanceof Error ? err.message : 'Could not create a replacement question.',
      );
    }
  };

  if (done) {
    return (
      <View style={styles.flagDoneWrap}>
        <Text style={styles.flagDone}>
          Thanks — this question is hidden for you from now on and queued for review.
        </Text>
        {replacement === 'done' ? (
          <Text style={styles.flagDone}>
            A replacement question was added — it appears next time you open this quiz.
          </Text>
        ) : (
          <>
            <Button
              small
              variant="secondary"
              label="Generate a replacement"
              icon="refresh-outline"
              onPress={() => void getReplacement()}
              loading={replacement === 'busy'}
            />
            {replacementError ? (
              <Text style={styles.flagError}>{replacementError}</Text>
            ) : null}
          </>
        )}
      </View>
    );
  }

  if (!open) {
    return (
      <Pressable hitSlop={8} onPress={() => setOpen(true)}>
        <Text style={styles.flagLink}>Report a problem</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.flagCard}>
      <View style={styles.flagReasons}>
        {REASON_OPTIONS.map((option) => {
          const active = option.value === reason;
          return (
            <Pressable
              key={option.value}
              onPress={() => setReason(option.value)}
              style={[styles.flagChip, active && styles.flagChipActive]}
            >
              <Text style={[styles.flagChipText, active && styles.flagChipTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={styles.flagError}>{error}</Text> : null}
      <View style={styles.flagActions}>
        <Button small variant="secondary" label="Cancel" onPress={() => setOpen(false)} />
        <Button small variant="danger" label="Send report" onPress={() => void send()} loading={busy} />
      </View>
    </View>
  );
}

/** Source-page citation: "From page 412 — quote". */
function Citation({ mcq }: { mcq: Mcq }) {
  if (!mcq.source_page && !mcq.supporting_quote) return null;
  return (
    <View style={styles.citation}>
      <Ionicons name="book-outline" size={15} color={colors.accent} />
      <View style={styles.citationBody}>
        {mcq.source_page ? (
          <Text style={styles.citationPage}>From page {mcq.source_page}</Text>
        ) : null}
        {mcq.supporting_quote ? (
          <Text style={styles.citationQuote}>“{mcq.supporting_quote}”</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function QuizScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [set, setSet] = useState<McqSetWithContext | null>(null);
  const [mcqs, setMcqs] = useState<Mcq[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [phase, setPhase] = useState<'intro' | 'running' | 'done'>('intro');
  const [mode, setMode] = useState<QuizMode>('tutor');
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [clozeDrafts, setClozeDrafts] = useState<Record<number, string>>({});
  const { elapsed, getElapsed, resetElapsed } = useQuizClock(phase === 'running');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setError('No quiz was selected.');
      setLoading(false);
      return;
    }

    try {
      const data = await api.get<{
        set: McqSetWithContext;
        mcqs: Mcq[];
        flaggedIds: string[];
        chapters: {
          id: string;
          title: string;
          number: number;
          book: { id: string; title: string; subject: string };
        }[];
      }>(`/api/sets/${id}`);

      setSet({ ...data.set, chapter: data.chapters[0] ?? null });
      setError(null);

      const flagged = new Set(data.flaggedIds);
      const visible = data.mcqs.filter((mcq) => !flagged.has(mcq.id));
      setMcqs(visible);
      setHiddenCount(data.mcqs.length - visible.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Quiz not found.');
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const current = mcqs[index];
  const revealed = mode === 'tutor' && selected !== null;
  const isLast = index + 1 >= mcqs.length;

  const score = mcqs.reduce(
    (sum, mcq, mcqIndex) => sum + (answers[mcqIndex] === mcq.correct_index ? 1 : 0),
    0,
  );

  const choose = (optionIndex: number) => {
    if (!current) return;
    if (mode === 'tutor' && selected !== null) return; // locked after feedback
    setSelected(optionIndex);
    setAnswers((previous) => {
      const next = [...previous];
      next[index] = optionIndex;
      return next;
    });
  };

  const submitCloze = () => {
    if (!current || selected !== null) return;
    const draft = (clozeDrafts[index] ?? '').trim();
    if (!draft) return;
    const ok = isClozeCorrect(draft, current.options[0] ?? '');
    setSelected(ok ? 0 : -1);
    setAnswers((previous) => {
      const next = [...previous];
      next[index] = ok ? 0 : -1;
      return next;
    });
  };

  const finish = async () => {
    setPhase('done');
    if (mcqs.length === 0) return;
    setSaving(true);

    // Cloze answers typed in exam mode were never checked — grade them now.
    const final = [...answers];
    mcqs.forEach((mcq, mcqIndex) => {
      if (mcq.question_type === 'cloze' && final[mcqIndex] === undefined) {
        const draft = clozeDrafts[mcqIndex] ?? '';
        final[mcqIndex] = isClozeCorrect(draft, mcq.options[0] ?? '') ? 0 : -1;
      }
    });
    const finalScore = mcqs.reduce(
      (sum, mcq, mcqIndex) => sum + (final[mcqIndex] === mcq.correct_index ? 1 : 0),
      0,
    );
    setAnswers(final);

    try {
      await api.post(`/api/sets/${id}/attempts`, {
        score: finalScore,
        total: mcqs.length,
        answers: final,
        mode,
        duration_seconds: getElapsed(),
      });
    } catch (err) {
      setError(
        `Your score could not be saved: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    // Spaced repetition: missed questions (and questions already in review)
    // are rescheduled — correct answers stretch the interval out.
    try {
      const existing = await api.get<
        {
          question_id: string;
          stability: number;
          difficulty: number;
          reps: number;
          lapses: number;
        }[]
      >(`/api/sets/${id}/reviews`);

      const byQuestion = new Map(existing.map((row) => [row.question_id, row]));

      const rows = mcqs.flatMap((mcq, mcqIndex) => {
        const correct = final[mcqIndex] === mcq.correct_index;
        const prior = byQuestion.get(mcq.id);
        if (!prior && correct) return []; // only track missed questions first
        const schedule = scheduleReview(prior ?? null, correct);
        return [{ question_id: mcq.id, ...schedule }];
      });

      if (rows.length > 0) {
        await api.post('/api/reviews', { rows });
      }
    } catch {
      // Review scheduling is best-effort — never blocks the results screen.
    }

    setSaving(false);
  };

  const next = () => {
    if (isLast) {
      void finish();
    } else {
      setIndex((value) => value + 1);
      setSelected(null);
    }
  };

  const restart = (nextMode?: QuizMode) => {
    if (nextMode) setMode(nextMode);
    setIndex(0);
    setSelected(null);
    setAnswers([]);
    resetElapsed();
    setPhase('intro');
    setError(null);
  };

  if (loading) {
    return <LoadingView label="Loading quiz…" />;
  }

  if (error && mcqs.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Quiz' }} />
        <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} />
      </Screen>
    );
  }

  if (mcqs.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Quiz' }} />
        <EmptyState
          icon="flag-outline"
          title={hiddenCount > 0 ? 'All questions were reported' : 'No questions in this quiz'}
          message={
            hiddenCount > 0
              ? 'You reported every question in this set as wrong or unclear, so they are hidden. Generate a fresh set from the chapter.'
              : 'Something went wrong while generating it. Go back and try again.'
          }
          actionLabel="Go back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  // ── Intro: choose a mode ────────────────────────────────────────────────────
  if (phase === 'intro') {
    const typeLabel = TYPE_LABELS[current?.question_type ?? 'single_best_answer'] ?? 'MCQs';
    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: 'Quiz' }} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {set?.chapter ? (
            <Text style={styles.quizContext}>
              {set.chapter.book?.title ?? 'Book'} · Ch. {set.chapter.number} —{' '}
              {set.chapter.title}
            </Text>
          ) : null}

          <Card style={styles.introCard}>
            <Text style={styles.introTitle}>{set?.title ?? 'Quiz'}</Text>
            <Text style={styles.introMeta}>
              {mcqs.length} questions · {typeLabel} ·{' '}
              {(set?.difficulty ?? 'medium').charAt(0).toUpperCase() +
                (set?.difficulty ?? 'medium').slice(1)}
            </Text>

            {hiddenCount > 0 ? (
              <Text style={styles.introHidden}>
                {hiddenCount} question{hiddenCount === 1 ? '' : 's'} hidden — you reported{' '}
                {hiddenCount === 1 ? 'it' : 'them'} earlier.
              </Text>
            ) : null}

            {error ? <ErrorBanner message={error} /> : null}

            <Text style={styles.modeTitle}>Choose a mode</Text>

            <Pressable
              onPress={() => setMode('tutor')}
              style={[styles.modeCard, mode === 'tutor' && styles.modeCardActive]}
            >
              <Ionicons name="school-outline" size={20} color={colors.primary} />
              <View style={styles.modeText}>
                <Text style={styles.modeName}>Tutor mode</Text>
                <Text style={styles.modeDesc}>
                  See the answer, why each option is right or wrong, and the book page after each
                  question.
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => setMode('exam')}
              style={[styles.modeCard, mode === 'exam' && styles.modeCardActive]}
            >
              <Ionicons name="timer-outline" size={20} color={colors.accent} />
              <View style={styles.modeText}>
                <Text style={styles.modeName}>Exam mode</Text>
                <Text style={styles.modeDesc}>
                  Answer everything first — timed, like the real exam. Results and explanations at
                  the end.
                </Text>
              </View>
            </Pressable>

            <Button label={`Start in ${mode === 'tutor' ? 'Tutor' : 'Exam'} mode`} onPress={() => setPhase('running')} />
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  if (phase === 'done') {
    const pct = percentage(score, mcqs.length);
    const message =
      pct >= 90
        ? 'Outstanding — exam ready.'
        : pct >= 70
          ? 'Solid work. Review the misses below.'
          : pct >= 50
            ? 'Good start — read the explanations and retake.'
            : 'Keep going. Read the chapter, then try again.';

    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: 'Results' }} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Card style={styles.resultCard}>
            <Text style={styles.resultPct}>{pct}%</Text>
            <Text style={styles.resultScore}>
              {score} / {mcqs.length} correct · {mode === 'tutor' ? 'Tutor' : 'Exam'} mode ·{' '}
              {formatClock(elapsed)}
            </Text>
            <Text style={styles.resultMessage}>{message}</Text>
            {saving ? <Text style={styles.resultSaving}>Saving score…</Text> : null}
          </Card>

          {error ? <ErrorBanner message={error} /> : null}

          <Text style={styles.sectionTitle}>Review</Text>
          {mcqs.map((mcq, mcqIndex) => {
            const answered = answers[mcqIndex];
            const correct = answered === mcq.correct_index;
            return (
              <Card key={mcq.id} style={styles.reviewCard}>
                <View style={styles.reviewHeader}>
                  <Text style={styles.reviewNumber}>Question {mcqIndex + 1}</Text>
                  <Ionicons
                    name={correct ? 'checkmark-circle' : 'close-circle'}
                    size={20}
                    color={correct ? colors.success : colors.danger}
                  />
                </View>
                <Text style={styles.questionText}>{mcq.question}</Text>

                {mcq.question_type === 'cloze' ? (
                  <>
                    <Text
                      style={[
                        styles.reviewAnswer,
                        { color: correct ? colors.success : colors.danger },
                      ]}
                    >
                      Your answer: {(clozeDrafts[mcqIndex] ?? '').trim() || '—'}
                    </Text>
                    {!correct ? (
                      <Text style={[styles.reviewAnswer, { color: colors.success }]}>
                        Answer: {mcq.options[0]}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text
                      style={[
                        styles.reviewAnswer,
                        { color: correct ? colors.success : colors.danger },
                      ]}
                    >
                      Your answer: {answered !== undefined ? LETTERS[answered] : '—'}.{' '}
                      {answered !== undefined ? mcq.options[answered] : 'Not answered'}
                    </Text>
                    {!correct ? (
                      <Text style={[styles.reviewAnswer, { color: colors.success }]}>
                        Correct: {LETTERS[mcq.correct_index]}. {mcq.options[mcq.correct_index]}
                      </Text>
                    ) : null}
                  </>
                )}

                {mcq.explanation ? (
                  <Text style={styles.explanation}>{mcq.explanation}</Text>
                ) : null}

                <Citation mcq={mcq} />
                <ReportControl questionId={mcq.id} />
              </Card>
            );
          })}

          <View style={styles.resultActions}>
            <Button label="Retake" variant="secondary" onPress={() => restart()} />
            <Button label="Done" onPress={() => router.back()} />
          </View>
        </ScrollView>
      </Screen>
    );
  }

  // ── Question view (running) ────────────────────────────────────────────────
  const progress = ((index + 1) / mcqs.length) * 100;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: set?.chapter?.book?.title ?? 'Quiz' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.progressWrap}>
          <Text style={styles.progressText}>
            Question {index + 1} of {mcqs.length}
          </Text>
          <View style={styles.progressRight}>
            <Ionicons name="time-outline" size={14} color={colors.textMuted} />
            <Text style={styles.progressScore}>{formatClock(elapsed)}</Text>
            {mode === 'tutor' ? <Text style={styles.progressScore}>· Score {score}</Text> : null}
          </View>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress}%` }]} />
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        {current.topic ? <Badge label={current.topic} color={colors.accent} /> : null}

        <Text style={styles.questionText}>{current.question}</Text>

        {current.question_type === 'cloze' ? (
          <View style={styles.clozeWrap}>
            <TextInput
              value={clozeDrafts[index] ?? ''}
              onChangeText={(text) =>
                setClozeDrafts((previous) => ({ ...previous, [index]: text }))
              }
              placeholder="Type the missing term..."
              placeholderTextColor={colors.textMuted}
              editable={!revealed}
              autoCorrect={false}
              autoCapitalize="none"
              style={[
                styles.clozeInput,
                revealed && selected === 0 && styles.clozeInputCorrect,
                revealed && selected !== 0 && styles.clozeInputWrong,
              ]}
            />
            {mode === 'tutor' && selected === null ? (
              <Button
                label="Check answer"
                icon="checkmark-outline"
                disabled={!(clozeDrafts[index] ?? '').trim()}
                onPress={submitCloze}
              />
            ) : null}
            {revealed ? (
              <Text
                style={[
                  styles.reviewAnswer,
                  { color: selected === 0 ? colors.success : colors.danger },
                ]}
              >
                {selected === 0 ? 'Correct!' : `Answer: ${current.options[0]}`}
              </Text>
            ) : null}
          </View>
        ) : (
        <View style={styles.options}>
          {current.options.map((option, optionIndex) => {
            const isCorrect = optionIndex === current.correct_index;
            const isChosen = optionIndex === selected;
            const showCorrect = revealed && isCorrect;
            const showWrong = revealed && isChosen && !isCorrect;
            const dimmed = revealed && !isCorrect && !isChosen;
            const examChosen = mode === 'exam' && isChosen;

            return (
              <Pressable
                key={optionIndex}
                disabled={revealed}
                onPress={() => choose(optionIndex)}
                style={({ pressed }) => [
                  styles.option,
                  dimmed && styles.optionDimmed,
                  showCorrect && styles.optionCorrect,
                  showWrong && styles.optionWrong,
                  examChosen && styles.optionExamChosen,
                  pressed && styles.optionPressed,
                ]}
              >
                <View
                  style={[
                    styles.letter,
                    showCorrect && styles.letterCorrect,
                    showWrong && styles.letterWrong,
                    examChosen && styles.letterExamChosen,
                  ]}
                >
                  <Text
                    style={[
                      styles.letterText,
                      showCorrect && styles.letterTextCorrect,
                      showWrong && styles.letterTextWrong,
                      examChosen && styles.letterTextExamChosen,
                    ]}
                  >
                    {LETTERS[optionIndex]}
                  </Text>
                </View>
                <Text style={styles.optionText}>{option}</Text>
                {revealed && isCorrect ? (
                  <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                ) : null}
                {revealed && isChosen && !isCorrect ? (
                  <Ionicons name="close-circle" size={20} color={colors.danger} />
                ) : null}
                {examChosen ? <Ionicons name="radio-button-on" size={18} color={colors.primary} /> : null}
              </Pressable>
            );
          })}
        </View>
        )}

        {mode === 'tutor' && revealed ? (
          <Card style={styles.explanationCard}>
            <View style={styles.explanationHeader}>
              <Ionicons
                name={selected === current.correct_index ? 'checkmark-circle' : 'information-circle'}
                size={18}
                color={selected === current.correct_index ? colors.success : colors.warning}
              />
              <Text style={styles.explanationTitle}>
                {selected === current.correct_index ? 'Correct!' : 'Not quite'}
              </Text>
            </View>

            {current.explanation ? (
              <Text style={styles.explanation}>{current.explanation}</Text>
            ) : null}

            {current.question_type === 'cloze' && current.option_explanations?.[0] ? (
              <Text style={styles.explanation}>Why: {current.option_explanations[0]}</Text>
            ) : null}

            {current.question_type !== 'cloze' && current.option_explanations && current.option_explanations.some(Boolean) ? (
              <View style={styles.optionExplanations}>
                <Text style={styles.optionExplanationsTitle}>Why each option:</Text>
                {current.options.map((option, optionIndex) => {
                  const rationale = current.option_explanations?.[optionIndex];
                  if (!rationale) return null;
                  const correct = optionIndex === current.correct_index;
                  return (
                    <View key={optionIndex} style={styles.rationaleRow}>
                      <Text
                        style={[
                          styles.rationaleLetter,
                          { color: correct ? colors.success : colors.danger },
                        ]}
                      >
                        {LETTERS[optionIndex]}
                      </Text>
                      <Text style={styles.rationaleText}>{rationale}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            <Citation mcq={current} />
          </Card>
        ) : mode === 'tutor' ? (
          <Text style={styles.pickHint}>Pick the best answer to see the explanation.</Text>
        ) : (
          <Text style={styles.pickHint}>
            Exam mode — you can change your answer until you tap Next.
          </Text>
        )}

        <View style={styles.reportRow}>
          <ReportControl key={current.id} questionId={current.id} />
        </View>

        <Button
          label={isLast ? 'Finish quiz' : 'Next question'}
          onPress={next}
          disabled={mode === 'tutor' && !revealed}
        />
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
  quizContext: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  progressWrap: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
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
  optionExamChosen: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '12'),
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
  letterExamChosen: {
    backgroundColor: withAlpha(colors.primary, '26'),
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
  letterTextExamChosen: {
    color: colors.primary,
  },
  clozeWrap: { gap: 10 },
  clozeInput: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: fontSize.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  clozeInputCorrect: { borderColor: colors.success },
  clozeInputWrong: { borderColor: colors.danger },
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
  optionExplanations: {
    gap: 6,
    marginTop: 2,
  },
  optionExplanationsTitle: {
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  rationaleRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  rationaleLetter: {
    fontWeight: '800',
    fontSize: fontSize.sm,
    width: 16,
  },
  rationaleText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
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
  reportRow: {
    alignItems: 'center',
  },
  flagLink: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textDecorationLine: 'underline',
  },
  flagDoneWrap: {
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  flagDone: {
    color: colors.success,
    fontSize: fontSize.xs,
    lineHeight: 17,
  },
  flagCard: {
    alignSelf: 'stretch',
    gap: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
  },
  flagReasons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  flagChip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  flagChipActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  flagChipText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  flagChipTextActive: {
    color: colors.primary,
    fontWeight: '800',
  },
  flagError: {
    color: colors.dangerText,
    fontSize: fontSize.xs,
  },
  flagActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  introCard: {
    gap: spacing.md,
  },
  introTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
    lineHeight: 26,
  },
  introMeta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  introHidden: {
    color: colors.warning,
    fontSize: fontSize.xs,
  },
  modeTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  modeCard: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  modeCardActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '12'),
  },
  modeText: {
    flex: 1,
    gap: 2,
  },
  modeName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  modeDesc: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  resultCard: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  resultPct: {
    color: colors.primary,
    fontSize: 52,
    fontWeight: '800',
    letterSpacing: -1,
  },
  resultScore: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    textAlign: 'center',
  },
  resultMessage: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
  resultSaving: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  reviewCard: {
    gap: spacing.sm,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reviewNumber: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reviewAnswer: {
    fontSize: fontSize.sm,
    lineHeight: 20,
    fontWeight: '600',
  },
  resultActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
});
