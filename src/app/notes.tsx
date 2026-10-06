// "My notes" — every highlight and note across the whole library, searchable
// and exportable. Tapping an entry opens the reader right on that passage.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, EmptyState, ErrorBanner, Input, LoadingView } from '@/components/ui';
import { getAllNotes, type LibraryNote } from '@/lib/api';
import { exportNotesMarkdown } from '@/lib/exportNotes';
import { HIGHLIGHT_DOTS, type HighlightColor } from '@/lib/highlight-colors';
import { colors } from '@/theme';

export default function NotesScreen() {
  const router = useRouter();
  const [notes, setNotes] = useState<LibraryNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      setNotes(await getAllNotes());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your notes.');
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      notes.filter((note) => {
        if (!query) return true;
        return (
          (note.note ?? '').toLowerCase().includes(query) ||
          note.text.toLowerCase().includes(query) ||
          (note.book_title ?? '').toLowerCase().includes(query) ||
          (note.chapter_title ?? '').toLowerCase().includes(query)
        );
      }),
    [notes, query],
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: 'My notes' }} />
      {loading ? (
        <LoadingView label="Gathering your notes…" />
      ) : (
        <View style={styles.flex}>
          <View style={styles.tools}>
            <Input
              placeholder="Search all highlights and notes…"
              value={search}
              onChangeText={setSearch}
              autoCorrect={false}
              style={styles.search}
            />
            {notes.length > 0 ? (
              <Button
                label="Export"
                icon="share-outline"
                variant="secondary"
                small
                onPress={() =>
                  void exportNotesMarkdown('Athena notes', filtered.length > 0 ? filtered : notes)
                }
              />
            ) : null}
          </View>
          {error ? <ErrorBanner message={error} /> : null}
          {notes.length === 0 ? (
            <EmptyState
              icon="bookmarks-outline"
              title="No notes yet"
              message="Long-press any passage while reading to highlight it or attach a note — everything you save collects here."
            />
          ) : filtered.length === 0 ? (
            <EmptyState icon="search-outline" title="No matches" message="Try different words." />
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
              {filtered.map((note) => (
                <Pressable
                  key={note.id}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  onPress={() =>
                    router.push({
                      pathname: '/reader/[bookId]',
                      params: {
                        bookId: note.book_id,
                        jumpChapter: note.chapter_id,
                        jumpParagraph: String(note.paragraph_index),
                      },
                    })
                  }
                >
                  <View style={styles.rowTop}>
                    <View
                      style={[
                        styles.dot,
                        {
                          backgroundColor:
                            HIGHLIGHT_DOTS[(note.color ?? 'gold') as HighlightColor] ??
                            HIGHLIGHT_DOTS.gold,
                        },
                      ]}
                    />
                    <Text style={styles.rowMeta} numberOfLines={1}>
                      {note.book_title} · Ch. {note.chapter_number} · {note.chapter_title}
                    </Text>
                    <Ionicons name="arrow-forward" size={14} color={colors.textMuted} />
                  </View>
                  {note.kind === 'note' && note.note ? (
                    <Text style={styles.noteText}>{note.note}</Text>
                  ) : null}
                  {note.text ? (
                    <Text style={styles.quote} numberOfLines={3}>
                      “{note.text}”
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  search: { flex: 1 },
  list: { paddingBottom: 32 },
  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { opacity: 0.7 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowMeta: { color: colors.textMuted, fontSize: 12, fontWeight: '600', flex: 1 },
  noteText: { color: colors.text, lineHeight: 21 },
  quote: { color: colors.textMuted, fontStyle: 'italic', lineHeight: 21, marginTop: 4 },
});
