// Mock exam — a timed run built from questions you already have, mixed across
// a book's chapters. Pick a book and a size; Athena assembles a fresh quiz set
// and you take it in Exam mode.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { QuestionType } from '@/types';

const COUNT_OPTIONS = [20, 40] as const;

interface BookOption {
  id: string;
  title: string;
  subject: string;
  count: number;
}

/** A question row as returned by GET /api/mcqs. */
interface QuestionFull {
  id: string;
  chapter_id: string | null;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  option_explanations: string[] | null;
  question_type: QuestionType;
  source_page: number | null;
  supporting_quote: string | null;
  topic: string | null;
  book_id: string | null;
  book_title: string | null;
  book_subject: string | null;
}

export default function MockExamScreen() {
  const router = useRouter();

  const [books, setBooks] = useState<BookOption[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [count, setCount] = useState<number>(20);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.get<BookOption[]>('/api/mcqs/books');
      setError(null);
      setBooks(list);
      setSelectedBookId((previous) => list.some((book) => book.id === previous)
        ? previous : (list[0]?.id ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your questions.');
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const start = async () => {
    if (!selectedBookId) return;
    const book = books.find((entry) => entry.id === selectedBookId);
    if (!book) return;

    setBusy(true);
    setError(null);
    try {
      // Fetch this book at build time so other books cannot crowd it out.
      const questions = await api.get<QuestionFull[]>(
        `/api/mcqs?book_id=${encodeURIComponent(book.id)}&limit=${count}&sample=true`,
      );
      // Fisher–Yates gives every question an equal chance of being selected.
      const shuffled = [...questions];
      for (let index = shuffled.length - 1; index > 0; index--) {
        const target = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
      }
      const copies = shuffled.slice(0, Math.min(count, shuffled.length))
        .map((row) => ({
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

      if (copies.length === 0) {
        throw new Error('No questions available for this book.');
      }

      const created = await api.post<{ id: string }>('/api/sets', {
        title: `Mock exam — ${book.title}`,
        difficulty: 'medium',
      });

      // Copy the sampled questions into the new set (server assigns positions).
      try {
        await api.post(`/api/sets/${created.id}/questions`, { questions: copies });
      } catch (copyError) {
        await api.del(`/api/sets/${created.id}`).catch(() => {});
        throw copyError;
      }

      router.push({ pathname: '/quiz/[id]', params: { id: created.id } });
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
                          {book.subject} · {book.count} questions available
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
              {selectedBook && selectedBook.count < count ? (
                <Text style={styles.hint}>
                  This book only has {selectedBook.count} questions — the exam will use
                  all of them.
                </Text>
              ) : null}
            </Card>

            <Button
              label={selectedBook ? `Start mock exam (${Math.min(count, selectedBook.count)} questions)` : 'Start mock exam'}
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
