import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Pressable,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BookCard } from '@/components/BookCard';
import { Screen } from '@/components/Screen';
import { Button, EmptyState, ErrorBanner, Input } from '@/components/ui';
import { getReadingList, type ReadingListItem } from '@/lib/api';
import { api } from '@/lib/apiClient';
import { colors, spacing, withAlpha } from '@/theme';
import type { BookWithCounts } from '@/types';

export default function LibraryScreen() {
  const router = useRouter();
  const [books, setBooks] = useState<BookWithCounts[]>([]);
  const [reading, setReading] = useState<ReadingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [data, readingData] = await Promise.all([
        api.get<BookWithCounts[]>('/api/books'),
        getReadingList(),
      ]);
      setError(null);
      setBooks(data);
      setReading(readingData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the library.');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const subjects = useMemo(
    () => [...new Set(books.map((book) => book.subject))].sort((a, b) => a.localeCompare(b)),
    [books],
  );

  const query = search.trim().toLowerCase();
  const filtered = books.filter((book) => {
    if (subjectFilter && book.subject !== subjectFilter) return false;
    if (!query) return true;
    return (
      book.title.toLowerCase().includes(query) || book.subject.toLowerCase().includes(query)
    );
  });

  return (
    <Screen padded={false}>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.titleText}>
                <Text style={styles.title}>Library</Text>
                <Text style={styles.subtitle}>
                  {books.length} {books.length === 1 ? 'book' : 'books'} · your uploads are private
                </Text>
              </View>
              <Button label="Add book" icon="add" small onPress={() => router.push('/upload')} />
            </View>
            {reading.length > 0 ? (
              <View style={styles.shelf}>
                <Text style={styles.shelfTitle}>Continue reading</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.shelfRow}
                >
                  {reading.map((item) => (
                    <Pressable
                      key={item.book_id}
                      style={styles.shelfCard}
                      onPress={() =>
                        router.push({
                          pathname: '/reader/[bookId]',
                          params: { bookId: item.book_id },
                        })
                      }
                    >
                      <View style={styles.shelfCover}>
                        <Ionicons name="book" size={20} color={colors.primary} />
                      </View>
                      <Text style={styles.shelfBook} numberOfLines={1}>
                        {item.book_title}
                      </Text>
                      <Text style={styles.shelfMeta} numberOfLines={1}>
                        {item.chapter_number ? `Ch. ${item.chapter_number} · ` : ''}
                        {Math.round(item.offset_ratio * 100)}%
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}
            <Input
              placeholder="Search by title or subject…"
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
            />
            {subjects.length > 1 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                <Pressable
                  onPress={() => setSubjectFilter(null)}
                  style={[styles.chip, !subjectFilter && styles.chipActive]}
                >
                  <Text style={[styles.chipText, !subjectFilter && styles.chipTextActive]}>
                    All
                  </Text>
                </Pressable>
                {subjects.map((subject) => {
                  const active = subjectFilter === subject;
                  return (
                    <Pressable
                      key={subject}
                      onPress={() => setSubjectFilter(active ? null : subject)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {subject}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}
            {error ? <ErrorBanner message={error} style={styles.error} /> : null}
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          ) : books.length > 0 ? (
            <EmptyState
              icon="search-outline"
              title="No matches"
              message="Try a different search or clear the subject filter."
            />
          ) : (
            <EmptyState
              icon="library-outline"
              title="No books yet"
              message="Upload a PDF, EPUB or TXT — or paste text — and Athena will split it into chapters and build quizzes for you."
              actionLabel="Add your first book"
              onAction={() => router.push('/upload')}
            />
          )
        }
        renderItem={({ item }) => (
          <View style={styles.cell}>
            <BookCard
              book={item}
              onPress={() =>
                router.push({ pathname: '/book/[id]', params: { id: item.id } })
              }
            />
          </View>
        )}
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
  row: {
    gap: 12,
    justifyContent: 'space-between',
  },
  cell: {
    width: '48.5%',
  },
  header: {
    gap: 12,
    marginBottom: 4,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleText: {
    flex: 1,
    gap: 2,
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
    marginTop: spacing.xs,
  },
  shelf: {
    gap: 8,
  },
  shelfTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '800',
  },
  shelfRow: {
    gap: 10,
    paddingRight: spacing.md,
  },
  shelfCard: {
    width: 150,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    padding: 10,
    gap: 6,
  },
  shelfCover: {
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.primary, '26'),
  },
  shelfBook: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  shelfMeta: {
    color: colors.textMuted,
    fontSize: 11,
  },
  spinner: {
    marginTop: 48,
  },
  chipRow: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.primary,
    fontWeight: '800',
  },
});
