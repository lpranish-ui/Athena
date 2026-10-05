// Mock exam — a timed run built from questions you already have, mixed across
// a book's chapters. Pick a book and a size; Athena assembles a fresh quiz set
// and you take it in Exam mode.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';

const COUNT_OPTIONS = [20, 40] as const;

interface BookOption {
  id: string;
  title: string;
  subject: string;
  questionIds: string[];
}

interface QuestionRow {
  id: string;
  chapter: { book_id: string; book: { id: string; title: string; subject: string } | null } | null;
}

export default function MockExamScreen() {
  const router = useRouter();
  const { user } = useAuth();

  const [books, setBooks] = useState<BookOption[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [count, setCount] = useState<number>(20);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from('mcqs')
      .select('id, chapter:chapters!inner(book_id, book:books(id, title, subject))')
      .limit(1000);

    if (loadError) {
      setError(loadError.message);
      setLoading(false);
      return;
    }

    const grouped = new Map<string, BookOption>();
    for (const row of (data ?? []) as unknown as QuestionRow[]) {
      const book = row.chapter?.book;
      if (!book || !row.chapter) continue;
      const entry = grouped.get(book.id) ?? {
        id: book.id,
        title: book.title,
        subject: book.subject,
        questionIds: [],
      };
      entry.questionIds.push(row.id);
      grouped.set(book.id, entry);
    }

    const list = [...grouped.values()].sort((a, b) => b.questionIds.length - a.questionIds.length);
    setBooks(list);
    setSelectedBookId(list[0]?.id ?? null);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const start = async () => {
    if (!user || !selectedBookId) return;
    const book = books.find((entry) => entry.id === selectedBookId);
    if (!book) return;

    setBusy(true);
    setError(null);
    try {
      // Sample questions across the book (shuffled).
      const shuffled = [...book.questionIds].sort(() => Math.random() - 0.5);
      const sampled = shuffled.slice(0, Math.min(count, shuffled.length));

      const { data: rows, error: rowsError } = await supabase
        .from('mcqs')
        .select('*')
        .in('id', sampled);
      if (rowsError || !rows || rows.length === 0) {
        throw new Error(rowsError?.message ?? 'No questions available for this book.');
      }

      const { data: set, error: setError } = await supabase
        .from('mcq_sets')
        .insert({
          chapter_id: null,
          chapter_ids: null,
          user_id: user.id,
          title: `Mock exam — ${book.title}`,
          difficulty: 'medium',
          status: 'ready',
        })
        .select('id')
        .single();
      if (setError || !set) {
        throw new Error(setError?.message ?? 'Could not create the mock exam.');
      }

      // Copy the sampled questions into the new set (older→newest order kept).
      const order = new Map(sampled.map((id, index) => [id, index]));
      const copies = (rows as Record<string, unknown>[])
        .sort((a, b) => (order.get(a.id as string) ?? 0) - (order.get(b.id as string) ?? 0))
        .map((row, index) => ({
          set_id: set.id,
          position: index + 1,
          question: row.question,
          options: row.options,
          correct_index: row.correct_index,
          explanation: row.explanation,
          option_explanations: row.option_explanations,
          question_type: row.question_type,
          source_page: row.source_page,
          supporting_quote: row.supporting_quote,
          topic: row.topic,
          chapter_id: row.chapter_id,
        }));

      const { error: copyError } = await supabase.from('mcqs').insert(copies);
      if (copyError) {
        await supabase.from('mcq_sets').delete().eq('id', set.id);
        throw new Error(copyError.message);
      }

      router.push({ pathname: '/quiz/[id]', params: { id: set.id as string } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the mock exam.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <LoadingView label="Assembling your question pool…" />;
  }

  const selectedBook = books.find((entry) => entry.id === selectedBookId) ?? null;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Mock exam' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          A timed run across one book’s chapters, built from questions you have already generated.
          Pick Exam mode when you start — results and explanations come at the end.
        </Text>

        {error ? <ErrorBanner message={error} /> : null}

        {books.length === 0 ? (
          <EmptyState
            icon="timer-outline"
            title="No questions to build from"
            message="Generate some quizzes from your books first — the mock exam draws from your existing questions."
            actionLabel="Back"
            onAction={() => router.back()}
          />
        ) : (
          <>
            <Card style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="library-outline" size={18} color={colors.primary} />
                <Text style={styles.cardTitle}>Pick a book</Text>
              </View>
              <View style={styles.bookList}>
                {books.map((book) => {
                  const active = book.id === selectedBookId;
                  return (
                    <Pressable
                      key={book.id}
                      onPress={() => setSelectedBookId(book.id)}
                      style={[styles.bookRow, active && styles.bookRowActive]}
                    >
                      <View style={styles.bookInfo}>
                        <Text style={styles.bookTitle} numberOfLines={1}>
                          {book.title}
                        </Text>
                        <Text style={styles.bookMeta}>
                          {book.subject} · {book.questionIds.length} questions available
                        </Text>
                      </View>
                      {active ? (
                        <Ionicons name="radio-button-on" size={18} color={colors.primary} />
                      ) : (
                        <Ionicons name="radio-button-off" size={18} color={colors.textMuted} />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </Card>

            <Card style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="options-outline" size={18} color={colors.primary} />
                <Text style={styles.cardTitle}>Questions</Text>
              </View>
              <View style={styles.countRow}>
                {COUNT_OPTIONS.map((option) => {
                  const active = option === count;
                  return (
                    <Pressable
                      key={option}
                      onPress={() => setCount(option)}
                      style={[styles.segment, active && styles.segmentActive]}
                    >
                      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                        {option}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {selectedBook && selectedBook.questionIds.length < count ? (
                <Text style={styles.hint}>
                  This book only has {selectedBook.questionIds.length} questions — the exam will use
                  all of them.
                </Text>
              ) : null}
            </Card>

            <Button
              label={selectedBook ? `Start mock exam (${Math.min(count, selectedBook.questionIds.length)} questions)` : 'Start mock exam'}
              icon="play-outline"
              onPress={() => void start()}
              loading={busy}
              disabled={!selectedBook}
            />
          </>
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
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
  },
  intro: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 21,
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
  bookList: {
    gap: spacing.sm,
  },
  bookRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  bookRowActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '12'),
  },
  bookInfo: {
    flex: 1,
    gap: 1,
  },
  bookTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  bookMeta: {
    color: colors.textMuted,
    fontSize: 11,
  },
  countRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
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
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
});
