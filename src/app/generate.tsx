// Build a quiz from one or more chapters of a book.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { generateQuiz } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { ChapterSummary, Difficulty, QuestionType } from '@/types';

const MAX_CHAPTERS = 8;

const DIFFICULTY_OPTIONS: { label: string; value: Difficulty }[] = [
  { label: 'Easy', value: 'easy' },
  { label: 'Medium', value: 'medium' },
  { label: 'Hard', value: 'hard' },
];

const COUNT_OPTIONS = [
  { label: '10', value: 10 },
  { label: '20', value: 20 },
  { label: '50', value: 50 },
];

const QUESTION_TYPE_OPTIONS: { label: string; value: QuestionType }[] = [
  { label: 'Standard', value: 'single_best_answer' },
  { label: 'Vignette', value: 'vignette' },
  { label: 'True / False', value: 'true_false' },
];

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { label: string; value: T }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmentWrap}>
      <Text style={styles.segmentLabel}>{label}</Text>
      <View style={styles.segmentRow}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              onPress={() => onChange(option.value)}
              style={[styles.segment, active && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function GenerateScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const router = useRouter();

  const [bookTitle, setBookTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [questionType, setQuestionType] = useState<QuestionType>('single_best_answer');
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');

  const load = useCallback(async () => {
    if (!bookId) return;

    const [bookResult, chaptersResult] = await Promise.all([
      supabase.from('books').select('title, subject').eq('id', bookId).maybeSingle(),
      supabase
        .from('chapters')
        .select('id, book_id, number, title, first_page, last_page')
        .eq('book_id', bookId)
        .order('number', { ascending: true }),
    ]);

    if (bookResult.data) {
      const book = bookResult.data as { title: string; subject: string };
      setBookTitle(book.title);
      setSubject(book.subject);
    }

    const list = (chaptersResult.data ?? []) as ChapterSummary[];
    setChapters(list);
    setSelected((previous) => {
      if (previous.size > 0) return previous;
      return list.length > 0 ? new Set([list[0].id]) : new Set();
    });
    setLoading(false);
  }, [bookId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const toggle = (chapterId: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(chapterId)) {
        next.delete(chapterId);
      } else {
        next.add(chapterId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(chapters.slice(0, MAX_CHAPTERS).map((chapter) => chapter.id)));
  };
  const clearAll = () => setSelected(new Set());

  const allSelected = chapters.length > 0 && selected.size >= Math.min(chapters.length, MAX_CHAPTERS);

  const generate = async () => {
    const chapterIds = chapters
      .filter((chapter) => selected.has(chapter.id))
      .map((chapter) => chapter.id);

    if (chapterIds.length === 0) {
      setError('Pick at least one chapter.');
      return;
    }
    if (chapterIds.length > MAX_CHAPTERS) {
      setError(`Choose at most ${MAX_CHAPTERS} chapters per quiz.`);
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      const { setId } = await generateQuiz({
        chapterIds,
        count,
        difficulty,
        questionType,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      router.push({ pathname: '/quiz/[id]', params: { id: setId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed. Please try again.');
    } finally {
      setGenerating(false);
      setProgress(null);
    }
  };

  if (loading) {
    return <LoadingView label="Loading chapters…" />;
  }

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Build a quiz' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.bookName}>
          {bookTitle}
          {subject ? ` · ${subject}` : ''}
        </Text>

        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="list-outline" size={18} color={colors.primary} />
            <Text style={styles.cardTitle}>Chapters ({selected.size} selected)</Text>
            <View style={styles.headerSpace} />
            <Pressable onPress={() => (allSelected ? clearAll() : selectAll())}>
              <Text style={styles.link}>{allSelected ? 'Clear' : `Select up to ${MAX_CHAPTERS}`}</Text>
            </Pressable>
          </View>

          {chapters.length === 0 ? (
            <Text style={styles.hint}>This book has no chapters yet.</Text>
          ) : (
            <View style={styles.chapterList}>
              {chapters.map((chapter) => {
                const active = selected.has(chapter.id);
                return (
                  <Pressable
                    key={chapter.id}
                    onPress={() => toggle(chapter.id)}
                    style={[styles.chapterRow, active && styles.chapterRowActive]}
                  >
                    <View style={[styles.checkbox, active && styles.checkboxOn]}>
                      {active ? (
                        <Ionicons name="checkmark" size={14} color={colors.primaryText} />
                      ) : null}
                    </View>
                    <View style={styles.chapterInfo}>
                      <Text style={styles.chapterTitle} numberOfLines={1}>
                        {chapter.number}. {chapter.title}
                      </Text>
                      {chapter.first_page ? (
                        <Text style={styles.chapterMeta}>
                          p. {chapter.first_page}
                          {chapter.last_page && chapter.last_page !== chapter.first_page
                            ? `–${chapter.last_page}`
                            : ''}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Card>

        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="options-outline" size={18} color={colors.primary} />
            <Text style={styles.cardTitle}>Options</Text>
          </View>
          <Segmented
            label="Question type"
            options={QUESTION_TYPE_OPTIONS}
            value={questionType}
            onChange={setQuestionType}
          />
          <Segmented
            label="Questions (total)"
            options={COUNT_OPTIONS}
            value={count}
            onChange={setCount}
          />
          <Segmented
            label="Difficulty"
            options={DIFFICULTY_OPTIONS}
            value={difficulty}
            onChange={setDifficulty}
          />
        </Card>

        {error ? <ErrorBanner message={error} /> : null}

        <Button
          label={`Generate quiz from ${selected.size} chapter${selected.size === 1 ? '' : 's'}`}
          icon="sparkles-outline"
          onPress={() => void generate()}
          loading={generating}
          disabled={chapters.length === 0}
        />
        {generating && progress ? (
          <Text style={styles.progressText}>
            Generated {progress.done} of {progress.total} questions…
          </Text>
        ) : null}
        <Text style={styles.hint}>
          Questions are written only from the selected chapters; each cites its source page and
          chapter and passes a blind answer check. 50 questions are built in three passes and take
          a few minutes.
        </Text>
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
  bookName: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  headerSpace: {
    flex: 1,
  },
  link: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  chapterList: {
    gap: spacing.sm,
  },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  chapterRowActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '12'),
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chapterInfo: {
    flex: 1,
    gap: 1,
  },
  chapterTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  chapterMeta: {
    color: colors.textMuted,
    fontSize: 11,
  },
  segmentWrap: {
    gap: 6,
  },
  segmentLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  segmentRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  segmentActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  segmentText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.primary,
    fontWeight: '800',
  },
  progressText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
});
