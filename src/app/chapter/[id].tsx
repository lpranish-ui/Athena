import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { generateQuiz, generateStudyKit } from '@/lib/api';
import { api } from '@/lib/apiClient';
import { formatRelative } from '@/lib/format';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type {
  ChapterWithBook,
  Difficulty,
  McqSetWithContext,
  QuestionType,
  StudyMaterial,
} from '@/types';

interface SetRow {
  id: string;
  title: string | null;
  difficulty: Difficulty;
  created_at: string;
}

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

export default function ChapterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [chapter, setChapter] = useState<ChapterWithBook | null>(null);
  const [sets, setSets] = useState<SetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [questionType, setQuestionType] = useState<QuestionType>('single_best_answer');
  const [count, setCount] = useState(10);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [materials, setMaterials] = useState<{
    flashcards: StudyMaterial | null;
    summary: StudyMaterial | null;
  }>({ flashcards: null, summary: null });
  const [kitBusy, setKitBusy] = useState<'flashcards' | 'summary' | null>(null);

  const load = useCallback(async () => {
    if (!id) return;

    try {
      const [chapterData, setsData, materialsList] = await Promise.all([
        api.get<ChapterWithBook>(`/api/chapters/${id}`),
        api.get<McqSetWithContext[]>('/api/sets'),
        api.get<StudyMaterial[]>(`/api/study-materials?chapter_id=${id}`),
      ]);

      setChapter(chapterData);
      setError(null);
      setSets(
        setsData
          .filter((set) => set.chapter_id === id || (set.chapter_ids ?? []).includes(id))
          .map((set) => ({
            id: set.id,
            title: set.title,
            difficulty: set.difficulty,
            created_at: set.created_at,
          })),
      );
      setMaterials({
        flashcards: materialsList.find((material) => material.kind === 'flashcards') ?? null,
        summary: materialsList.find((material) => material.kind === 'summary') ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chapter not found.');
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const generate = async () => {
    if (!chapter) return;
    setGenerating(true);
    setError(null);
    try {
      const { setId } = await generateQuiz({
        chapterIds: [chapter.id],
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

  const makeKit = async (kind: 'flashcards' | 'summary') => {
    if (!chapter) return;
    setKitBusy(kind);
    setError(null);
    try {
      await generateStudyKit({ chapterId: chapter.id, kind });
      router.push(
        kind === 'flashcards'
          ? { pathname: '/flashcards', params: { chapterId: chapter.id } }
          : { pathname: '/summary', params: { chapterId: chapter.id } },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the study material.');
    } finally {
      setKitBusy(null);
    }
  };

  if (loading) {
    return <LoadingView label="Opening chapter…" />;
  }

  if (!chapter) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Chapter' }} />
        <ErrorBanner message={error ?? 'This chapter could not be found.'} />
      </Screen>
    );
  }

  const words = chapter.content.split(/\s+/).filter(Boolean).length;
  const isLong = chapter.content.length > 1400;
  const preview =
    expanded || !isLong ? chapter.content : `${chapter.content.slice(0, 1400).trimEnd()}…`;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: `Chapter ${chapter.number}` }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.bookName}>
            {chapter.book?.title ?? 'Unknown book'}
            {chapter.book?.subject ? ` · ${chapter.book.subject}` : ''}
          </Text>
          <Text style={styles.title}>{chapter.title}</Text>
        </View>

        <Card style={styles.readCard}>
          <View style={styles.readHeader}>
            <Ionicons name="reader-outline" size={18} color={colors.primary} />
            <Text style={styles.readLabel}>~{words.toLocaleString()} words</Text>
            {chapter.first_page ? (
              <Text style={styles.readLabel}>
                · pages {chapter.first_page}
                {chapter.last_page && chapter.last_page !== chapter.first_page
                  ? `–${chapter.last_page}`
                  : ''}
              </Text>
            ) : null}
          </View>
          <Text style={styles.readText}>{preview}</Text>
          {isLong ? (
            <Button
              label={expanded ? 'Collapse chapter' : 'Show full chapter'}
              variant="ghost"
              small
              onPress={() => setExpanded((value) => !value)}
            />
          ) : null}
        </Card>

        <Card style={styles.generatorCard}>
          <View style={styles.generatorHeader}>
            <Ionicons name="sparkles" size={18} color={colors.primary} />
            <Text style={styles.generatorTitle}>Build a quiz from this chapter</Text>
          </View>

          <Segmented
            label="Question type"
            options={QUESTION_TYPE_OPTIONS}
            value={questionType}
            onChange={setQuestionType}
          />
          <Segmented label="Questions" options={COUNT_OPTIONS} value={count} onChange={setCount} />
          <Segmented
            label="Difficulty"
            options={DIFFICULTY_OPTIONS}
            value={difficulty}
            onChange={setDifficulty}
          />

          {error ? <ErrorBanner message={error} /> : null}

          <Button
            label="Generate MCQs with AI"
            icon="sparkles-outline"
            onPress={() => void generate()}
            loading={generating}
          />
          {generating && progress ? (
            <Text style={styles.progressText}>
              Generated {progress.done} of {progress.total} questions…
            </Text>
          ) : null}
          <Text style={styles.hint}>
            DeepSeek writes questions from this chapter only and links each one to its page — every
            question must quote the chapter word-for-word and pass a blind answer check. 10–20
            questions take 10–30 seconds; 50 is built in three passes and takes a few minutes.
          </Text>
        </Card>

        <Card style={styles.kitCard}>
          <View style={styles.generatorHeader}>
            <Ionicons name="albums-outline" size={18} color={colors.accent} />
            <Text style={styles.generatorTitle}>Study kit</Text>
          </View>
          <View style={styles.kitRow}>
            <Button
              small
              variant={materials.flashcards ? 'primary' : 'secondary'}
              icon="albums-outline"
              label={materials.flashcards ? 'Review flashcards' : 'Make flashcards'}
              onPress={() =>
                materials.flashcards
                  ? router.push({ pathname: '/flashcards', params: { chapterId: chapter.id } })
                  : void makeKit('flashcards')
              }
              loading={kitBusy === 'flashcards'}
              style={styles.kitButton}
            />
            <Button
              small
              variant={materials.summary ? 'primary' : 'secondary'}
              icon="reader-outline"
              label={materials.summary ? 'Open summary' : 'Make summary'}
              onPress={() =>
                materials.summary
                  ? router.push({ pathname: '/summary', params: { chapterId: chapter.id } })
                  : void makeKit('summary')
              }
              loading={kitBusy === 'summary'}
              style={styles.kitButton}
            />
          </View>
          <Text style={styles.hint}>
            Flashcards are exportable to Anki; the summary is a one-page high-yield recap with page
            references.
          </Text>
        </Card>

        <Text style={styles.sectionTitle}>Your quizzes on this chapter</Text>

        {sets.length === 0 ? (
          <Text style={styles.emptyText}>
            Nothing yet — generate your first set of questions above.
          </Text>
        ) : (
          <View style={styles.setList}>
            {sets.map((set) => (
              <Pressable
                key={set.id}
                style={({ pressed }) => [styles.setRow, pressed && styles.pressed]}
                onPress={() => router.push({ pathname: '/quiz/[id]', params: { id: set.id } })}
              >
                <Badge
                  label={set.difficulty.charAt(0).toUpperCase() + set.difficulty.slice(1)}
                  color={
                    set.difficulty === 'easy'
                      ? colors.success
                      : set.difficulty === 'hard'
                        ? colors.danger
                        : colors.warning
                  }
                />
                <Text style={styles.setTitle} numberOfLines={1}>
                  {set.title ?? 'Quiz'}
                </Text>
                <Text style={styles.setDate}>{formatRelative(set.created_at)}</Text>
                <Ionicons name="play-circle-outline" size={22} color={colors.primary} />
              </Pressable>
            ))}
          </View>
        )}
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
  header: {
    gap: 4,
  },
  bookName: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    lineHeight: 30,
  },
  readCard: {
    gap: spacing.md,
  },
  readHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  readLabel: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  readText: {
    color: '#CBD5E1',
    fontSize: 15,
    lineHeight: 24,
  },
  generatorCard: {
    gap: spacing.md,
    borderColor: withAlpha(colors.primary, '44'),
  },
  kitCard: {
    gap: spacing.md,
    borderColor: withAlpha(colors.accent, '44'),
  },
  kitRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  kitButton: {
    flex: 1,
  },
  generatorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  generatorTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
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
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  setList: {
    gap: spacing.sm,
  },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  pressed: {
    opacity: 0.85,
  },
  setTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  setDate: {
    color: colors.textMuted,
    fontSize: 11,
  },
});
