import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    Alert,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { colors, fontSize, getSubjectColor, radius, spacing, withAlpha } from '@/theme';
import type { Book, ChapterSummary } from '@/types';

export default function BookScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;

    try {
      const bookData = await api.get<Book>(`/api/books/${id}`);
      setBook(bookData);
      setError(null);
      const chaptersData = await api.get<ChapterSummary[]>(`/api/books/${id}/chapters`);
      setChapters(chaptersData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Book not found.');
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const doDelete = async () => {
    if (!book) return;
    setBusy(true);
    try {
      await api.del(`/api/books/${book.id}`);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete this book.');
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    const message = 'This removes the book, its chapters and all quizzes generated from it.';
    if (Platform.OS === 'web') {
      const confirmFn = (globalThis as { confirm?: (text: string) => boolean }).confirm;
      if (!confirmFn || confirmFn(`Delete this book?\n\n${message}`)) {
        void doDelete();
      }
      return;
    }
    Alert.alert('Delete this book?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void doDelete() },
    ]);
  };

  if (loading) {
    return <LoadingView label="Opening book…" />;
  }

  if (!book) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Book' }} />
        <ErrorBanner message={error ?? 'This book could not be found.'} />
      </Screen>
    );
  }

  const cover = book.cover_color ?? getSubjectColor(book.subject);

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: book.title }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={[styles.cover, { backgroundColor: cover }]}>
            <Ionicons name="book" size={30} color="rgba(255,255,255,0.92)" />
          </View>
          <View style={styles.heroText}>
            <Text style={styles.title}>{book.title}</Text>
            {book.author ? <Text style={styles.author}>{book.author}</Text> : null}
            <View style={styles.badges}>
              <Badge label={book.subject} color={getSubjectColor(book.subject)} />
              <Badge
                label={book.is_default ? 'Built-in' : 'My upload'}
                color={book.is_default ? colors.primary : colors.accent}
              />
              <Badge
                label={`${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}`}
                color={colors.textMuted}
              />
            </View>
          </View>
        </View>

        {book.description ? <Text style={styles.description}>{book.description}</Text> : null}

        {chapters.length > 0 ? (
          <View style={styles.actionGroup}>
            <Button
              label="Read book"
              icon="book-outline"
              onPress={() =>
                router.push({ pathname: '/reader/[bookId]', params: { bookId: book.id } })
              }
            />
            <Button
              label="Build a quiz from chapters"
              icon="sparkles-outline"
              variant="secondary"
              onPress={() => router.push({ pathname: '/generate', params: { bookId: book.id } })}
            />
          </View>
        ) : null}

        {error ? <ErrorBanner message={error} /> : null}

        {book.status === 'processing' ? (
          <Card style={styles.notice}>
            <Text style={styles.noticeTitle}>Still processing…</Text>
            <Text style={styles.noticeText}>
              This book has not finished being split into chapters yet. Reopen this screen in a
              moment to check. If it stays stuck (for example the upload was interrupted), delete
              this book below and upload it again.
            </Text>
            <Button label="Check again" small onPress={() => void load()} loading={busy} />
          </Card>
        ) : null}

        {book.status === 'error' ? (
          <Card style={styles.notice}>
            <Text style={styles.noticeTitle}>Processing failed</Text>
            <Text style={styles.noticeText}>
              {book.status_message ??
                'We could not extract text from this file. Scanned PDFs are not supported yet — try pasting the text instead.'}{' '}
              Delete this book and upload it again, or paste the text instead.
            </Text>
          </Card>
        ) : null}

        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Chapters</Text>
          {!book.is_default && chapters.length > 0 ? (
            <Button
              label="Fix splits"
              icon="cut-outline"
              variant="secondary"
              small
              onPress={() =>
                router.push({ pathname: '/manage-chapters', params: { bookId: book.id } })
              }
            />
          ) : null}
        </View>

        {chapters.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Text style={styles.noticeText}>
              No chapters yet. If you just uploaded this book, processing may still be running.
            </Text>
          </Card>
        ) : (
          <View style={styles.chapterList}>
            {chapters.map((chapter) => (
              <Pressable
                key={chapter.id}
                style={({ pressed }) => [styles.chapterRow, pressed && styles.pressed]}
                onPress={() =>
                  router.push({ pathname: '/chapter/[id]', params: { id: chapter.id } })
                }
              >
                <View style={styles.chapterNumber}>
                  <Text style={styles.chapterNumberText}>{chapter.number}</Text>
                </View>
                <View style={styles.chapterInfo}>
                  <Text style={styles.chapterTitle} numberOfLines={2}>
                    {chapter.title}
                  </Text>
                  {chapter.first_page ? (
                    <Text style={styles.chapterPages}>
                      p. {chapter.first_page}
                      {chapter.last_page && chapter.last_page !== chapter.first_page
                        ? `–${chapter.last_page}`
                        : ''}
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </Pressable>
            ))}
          </View>
        )}

        {!book.is_default ? (
          <Button
            label="Delete this book"
            variant="danger"
            icon="trash-outline"
            onPress={confirmDelete}
            loading={busy}
            style={styles.deleteButton}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionGroup: {
    gap: spacing.sm,
  },
  content: {
    padding: 20,
    paddingBottom: 48,
    gap: spacing.md,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  hero: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
  },
  cover: {
    width: 72,
    height: 96,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroText: {
    flex: 1,
    gap: 6,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 28,
  },
  author: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  description: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 21,
  },
  notice: {
    gap: spacing.sm,
    borderColor: withAlpha(colors.warning, '55'),
  },
  noticeTitle: {
    color: colors.text,
    fontWeight: '700',
    fontSize: fontSize.md,
  },
  noticeText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  chapterList: {
    gap: spacing.sm,
  },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  pressed: {
    opacity: 0.85,
  },
  chapterNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: withAlpha(colors.primary, '1F'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  chapterNumberText: {
    color: colors.primary,
    fontWeight: '800',
    fontSize: fontSize.sm,
  },
  chapterInfo: {
    flex: 1,
    gap: 1,
  },
  chapterTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    lineHeight: 20,
  },
  chapterPages: {
    color: colors.textMuted,
    fontSize: 11,
  },
  emptyCard: {
    gap: spacing.sm,
  },
  deleteButton: {
    marginTop: spacing.lg,
  },
});
