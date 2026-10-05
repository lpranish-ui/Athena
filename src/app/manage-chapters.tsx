// Fix a book's chapter split — rename, split at a page, merge with the
// previous chapter, or delete.
//
// Notes:
// - Merging keeps your quizzes: they are re-pointed to the merged chapter
//   before the duplicate row is removed.
// - Splitting keeps quizzes on the first part; the new part starts fresh.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, ErrorBanner, Input, LoadingView } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { colors, fontSize, spacing, withAlpha } from '@/theme';
import type { Chapter, ChapterSummary, PageMark } from '@/types';

function validMarks(pageMap: PageMark[] | null): PageMark[] {
  if (!Array.isArray(pageMap)) return [];
  return pageMap
    .filter((mark) => Number.isInteger(mark?.page) && Number.isInteger(mark?.char_start))
    .sort((a, b) => a.char_start - b.char_start);
}

export default function ManageChaptersScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();

  const [bookTitle, setBookTitle] = useState('');
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const [splitPage, setSplitPage] = useState('');

  const reload = useCallback(async () => {
    if (!bookId) return;
    const [bookResult, chaptersResult] = await Promise.all([
      supabase.from('books').select('title').eq('id', bookId).maybeSingle(),
      supabase
        .from('chapters')
        .select('id, book_id, number, title, first_page, last_page')
        .eq('book_id', bookId)
        .order('number', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);
    if (bookResult.data) setBookTitle((bookResult.data as { title: string }).title);
    setChapters((chaptersResult.data ?? []) as ChapterSummary[]);
    setLoading(false);
  }, [bookId]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const confirmDialog = (title: string, message: string, onConfirm: () => void) => {
    if (Platform.OS === 'web') {
      const confirmFn = (globalThis as { confirm?: (text: string) => boolean }).confirm;
      if (!confirmFn || confirmFn(`${title}\n\n${message}`)) onConfirm();
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: onConfirm },
    ]);
  };

  /** Renumbers all chapters of the book to 1..n in current display order. */
  const renumber = async () => {
    if (!bookId) return;
    const { data } = await supabase
      .from('chapters')
      .select('id')
      .eq('book_id', bookId)
      .order('number', { ascending: true })
      .order('created_at', { ascending: true });
    if (!data) return;

    const rows = data.map((row, index) => ({ id: (row as { id: string }).id, number: index + 1 }));
    for (let i = 0; i < rows.length; i += 10) {
      await Promise.all(
        rows
          .slice(i, i + 10)
          .map((row) => supabase.from('chapters').update({ number: row.number }).eq('id', row.id)),
      );
    }
  };

  // ── rename ──────────────────────────────────────────────────────────────────

  const rename = async (chapterId: string) => {
    const title = renameText.trim();
    if (!title) return;
    await run(async () => {
      const { error: renameError } = await supabase
        .from('chapters')
        .update({ title })
        .eq('id', chapterId);
      if (renameError) throw new Error(renameError.message);
      setRenamingId(null);
      await reload();
    });
  };

  // ── merge with previous ─────────────────────────────────────────────────────

  const mergeWithPrevious = (index: number) => {
    const current = chapters[index];
    const previous = chapters[index - 1];
    if (!current || !previous) return;

    confirmDialog(
      `Merge chapter ${current.number} into chapter ${previous.number}?`,
      'The two chapters become one. Quizzes you generated from either chapter stay available.',
      () =>
        void run(async () => {
          const [prevResult, currResult] = await Promise.all([
            supabase.from('chapters').select('*').eq('id', previous.id).single(),
            supabase.from('chapters').select('*').eq('id', current.id).single(),
          ]);
          if (prevResult.error || currResult.error || !prevResult.data || !currResult.data) {
            throw new Error('Could not load the chapters to merge.');
          }

          const prev = prevResult.data as Chapter;
          const curr = currResult.data as Chapter;
          const shift = prev.content.length + 2;
          const mergedContent = `${prev.content}\n\n${curr.content}`;
          const prevMarks = validMarks(prev.page_map);
          const currMarks = validMarks(curr.page_map);
          const mergedMap =
            prevMarks.length > 0 && currMarks.length > 0
              ? [
                  ...prevMarks,
                  ...currMarks.map((mark) => ({ page: mark.page, char_start: mark.char_start + shift })),
                ]
              : null;

          const { error: updateError } = await supabase
            .from('chapters')
            .update({
              content: mergedContent,
              page_map: mergedMap,
              first_page: prev.first_page ?? curr.first_page,
              last_page: curr.last_page ?? prev.last_page,
            })
            .eq('id', prev.id);
          if (updateError) throw new Error(updateError.message);

          // Keep quizzes: re-point them before removing the merged row (deleting
          // the row would otherwise cascade-delete its quiz sets).
          const { error: repointError } = await supabase
            .from('mcq_sets')
            .update({ chapter_id: prev.id })
            .eq('chapter_id', curr.id);
          if (repointError) throw new Error(repointError.message);

          const { error: deleteError } = await supabase
            .from('chapters')
            .delete()
            .eq('id', curr.id);
          if (deleteError) throw new Error(deleteError.message);

          await renumber();
          await reload();
        }),
    );
  };

  // ── split ───────────────────────────────────────────────────────────────────

  const splitChapter = async (chapter: ChapterSummary, pageInput: string) => {
    await run(async () => {
      const { data: full, error: fetchError } = await supabase
        .from('chapters')
        .select('*')
        .eq('id', chapter.id)
        .single();
      if (fetchError || !full) throw new Error(fetchError?.message ?? 'Could not load the chapter.');

      const row = full as Chapter;
      const marks = validMarks(row.page_map);

      let cut = -1;
      let tailFirstPage: number | null = null;

      const requested = Number.parseInt(pageInput, 10);
      if (marks.length > 0 && Number.isFinite(requested)) {
        const mark = marks.find((m) => m.page === requested && m.char_start > 0);
        if (!mark || mark.char_start >= row.content.length - 1) {
          const low = (chapter.first_page ?? 1) + 1;
          throw new Error(
            `Page ${requested} can't start the new part — pick a page between ${low} and ${
              chapter.last_page ?? 'the end'
            }.`,
          );
        }
        cut = mark.char_start;
        tailFirstPage = requested;
      } else {
        // No page data (pasted text / EPUB): split near the middle at a paragraph break.
        const middle = Math.floor(row.content.length / 2);
        const breakAt = row.content.indexOf('\n\n', middle);
        cut = breakAt === -1 ? middle : breakAt + 2;
      }

      if (cut <= 0 || cut >= row.content.length - 1) {
        throw new Error('This chapter is too small to split.');
      }

      const head = row.content.slice(0, cut).trimEnd();
      const tailRaw = row.content.slice(cut);
      const tail = tailRaw.trimStart();
      const leading = tailRaw.length - tail.length;

      const headMarks = marks.filter((m) => m.char_start < cut);
      const tailMarks =
        marks.length > 0
          ? marks
              .filter((m) => m.char_start >= cut)
              .map((m) => ({ page: m.page, char_start: m.char_start - cut - leading }))
              .filter((m) => m.char_start >= 0)
          : [];
      const headLastPage = headMarks.length > 0 ? headMarks[headMarks.length - 1].page : row.first_page;
      const resolvedTailFirstPage =
        tailFirstPage ?? (tailMarks.length > 0 ? tailMarks[0].page : null);

      const { error: updateError } = await supabase
        .from('chapters')
        .update({
          content: head,
          last_page: headLastPage,
          page_map: headMarks.length > 0 ? headMarks : null,
        })
        .eq('id', row.id);
      if (updateError) throw new Error(updateError.message);

      const { error: insertError } = await supabase.from('chapters').insert({
        book_id: row.book_id,
        number: row.number + 1, // renumber resolves ordering by created_at
        title: `${row.title} — part 2`,
        content: tail,
        first_page: resolvedTailFirstPage,
        last_page: row.last_page,
        page_map: tailMarks.length > 0 ? tailMarks : null,
      });
      if (insertError) throw new Error(insertError.message);

      await renumber();
      setSplittingId(null);
      await reload();
    });
  };

  // ── delete ──────────────────────────────────────────────────────────────────

  const confirmDeleteChapter = (chapter: ChapterSummary) => {
    confirmDialog(
      `Delete "${chapter.title}"?`,
      'Its text is removed, and quizzes generated from this chapter are deleted too.',
      () =>
        void run(async () => {
          const { error: deleteError } = await supabase
            .from('chapters')
            .delete()
            .eq('id', chapter.id);
          if (deleteError) throw new Error(deleteError.message);
          await renumber();
          await reload();
        }),
    );
  };

  if (loading) {
    return <LoadingView label="Loading chapters…" />;
  }

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Fix chapters' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          {bookTitle ? `“${bookTitle}” · ` : ''}
          rename, split, merge or delete chapters. Splitting keeps quizzes on the first part;
          merging keeps quizzes from both.
        </Text>

        {error ? <ErrorBanner message={error} /> : null}

        {chapters.map((chapter, index) => {
          const midPage =
            chapter.first_page && chapter.last_page
              ? String(Math.floor((chapter.first_page + chapter.last_page) / 2))
              : '';

          return (
            <Card key={chapter.id} style={styles.chapterCard}>
              {renamingId === chapter.id ? (
                <View style={styles.renameRow}>
                  <View style={styles.renameInput}>
                    <Input value={renameText} onChangeText={setRenameText} autoFocus />
                  </View>
                  <Button small label="Save" onPress={() => void rename(chapter.id)} loading={busy} />
                  <Button small variant="ghost" label="Cancel" onPress={() => setRenamingId(null)} />
                </View>
              ) : (
                <View style={styles.chapterHeader}>
                  <View style={styles.chapterNumber}>
                    <Text style={styles.chapterNumberText}>{chapter.number}</Text>
                  </View>
                  <View style={styles.chapterInfo}>
                    <Text style={styles.chapterTitle}>{chapter.title}</Text>
                    <Text style={styles.chapterMeta}>
                      {chapter.first_page
                        ? `p. ${chapter.first_page}${
                            chapter.last_page && chapter.last_page !== chapter.first_page
                              ? `–${chapter.last_page}`
                              : ''
                          }`
                        : 'no page data'}
                    </Text>
                  </View>
                </View>
              )}

              {splittingId === chapter.id ? (
                <View style={styles.splitPanel}>
                  {chapter.first_page && chapter.last_page ? (
                    <Input
                      label={`Start the new part at page (${chapter.first_page}–${chapter.last_page})`}
                      value={splitPage}
                      onChangeText={setSplitPage}
                      keyboardType="number-pad"
                      placeholder={midPage}
                    />
                  ) : (
                    <Text style={styles.splitHint}>
                      This book has no page data, so the chapter will be split near its middle at a
                      paragraph break.
                    </Text>
                  )}
                  <View style={styles.actionRow}>
                    <Button
                      small
                      label="Split chapter"
                      icon="cut-outline"
                      onPress={() => void splitChapter(chapter, splitPage)}
                      loading={busy}
                    />
                    <Button small variant="ghost" label="Cancel" onPress={() => setSplittingId(null)} />
                  </View>
                </View>
              ) : (
                <View style={styles.actionRow}>
                  <Button
                    small
                    variant="secondary"
                    label="Rename"
                    onPress={() => {
                      setRenamingId(chapter.id);
                      setRenameText(chapter.title);
                    }}
                  />
                  <Button
                    small
                    variant="secondary"
                    label="Split"
                    onPress={() => {
                      setSplittingId(chapter.id);
                      setSplitPage(midPage);
                    }}
                  />
                  {index > 0 ? (
                    <Button
                      small
                      variant="secondary"
                      label="Merge ↑"
                      onPress={() => mergeWithPrevious(index)}
                    />
                  ) : null}
                  <Button
                    small
                    variant="danger"
                    label="Delete"
                    onPress={() => confirmDeleteChapter(chapter)}
                  />
                </View>
              )}
            </Card>
          );
        })}

        {chapters.length === 0 ? (
          <Card>
            <Text style={styles.splitHint}>
              This book has no chapters yet — process or upload it first.
            </Text>
          </Card>
        ) : null}

        <View style={styles.note}>
          <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
          <Text style={styles.noteText}>
            Splits and merges only change how the book is divided — generated questions you already
            have keep working.
          </Text>
        </View>
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
  intro: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 21,
  },
  chapterCard: {
    gap: spacing.md,
  },
  chapterHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
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
  chapterMeta: {
    color: colors.textMuted,
    fontSize: 11,
  },
  renameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  renameInput: {
    flex: 1,
  },
  splitPanel: {
    gap: spacing.sm,
  },
  splitHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  note: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    paddingHorizontal: spacing.xs,
  },
  noteText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
});
