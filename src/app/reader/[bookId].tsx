// The reader — a distraction-free way to actually read the books in Athena.
//
// Full text comes from the stored chapters (no re-parsing on the phone).
// The reading position is saved to the server (chapter + scroll ratio) so
// you resume exactly where you left off on any device.

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { LoadingView } from '@/components/ui';
import { ReaderParagraph } from '@/components/ReaderParagraph';
import { ReaderCell, ReaderCellLayoutContext } from '@/components/ReaderCell';
import { useReaderPosition } from '@/hooks/useReaderPosition';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addReaderNote,
  askBook,
  deleteReaderNote,
  getReaderNotes,
  getReadingProgress,
  searchBook,
  type BookAnswer,
  type BookSearchHit,
  type ReaderNote,
} from '@/lib/api';
import { exportNotesMarkdown } from '@/lib/exportNotes';
import { HIGHLIGHT_COLOR_KEYS, HIGHLIGHT_DOTS, type HighlightColor } from '@/lib/highlight-colors';
import { api } from '@/lib/apiClient';
import { spacing } from '@/theme';
import type { Book, ChapterSummary } from '@/types';

// ── reader themes ────────────────────────────────────────────────────────────

type ThemeName = 'dark' | 'sepia' | 'light';

const READER_THEMES: Record<ThemeName, { bg: string; text: string; muted: string; chrome: string; border: string }> = {
  dark: { bg: '#0B1220', text: '#E8ECF4', muted: '#8FA0BF', chrome: '#111a2e', border: '#1D2A44' },
  sepia: { bg: '#F7ECD8', text: '#3E2F1C', muted: '#8A7455', chrome: '#EFE1C6', border: '#DFCEAC' },
  light: { bg: '#FFFFFF', text: '#1C2333', muted: '#7A8699', chrome: '#F4F6FA', border: '#E4E9F2' },
};

type Spacing = 'cozy' | 'normal' | 'airy';
const LINE_HEIGHTS: Record<Spacing, number> = { cozy: 1.4, normal: 1.65, airy: 1.9 };

/** Per-color, per-theme tint behind highlighted passages. */
const HIGHLIGHT_TINTS: Record<HighlightColor, Record<ThemeName, string>> = {
  gold: { dark: 'rgba(216,154,40,0.22)', sepia: 'rgba(216,154,40,0.30)', light: 'rgba(216,154,40,0.20)' },
  blue: { dark: 'rgba(109,139,255,0.20)', sepia: 'rgba(96,125,239,0.22)', light: 'rgba(96,125,239,0.14)' },
  green: { dark: 'rgba(52,199,123,0.18)', sepia: 'rgba(52,199,123,0.20)', light: 'rgba(52,199,123,0.14)' },
  pink: { dark: 'rgba(232,120,170,0.20)', sepia: 'rgba(232,120,170,0.22)', light: 'rgba(232,120,170,0.15)' },
};

interface ReaderSettings {
  theme: ThemeName;
  fontSize: number;
  spacing: Spacing;
  serif: boolean;
}

const SETTINGS_KEY = 'athena.reader.settings';
const DEFAULT_SETTINGS: ReaderSettings = { theme: 'dark', fontSize: 18, spacing: 'normal', serif: false };
const READER_VIEWABILITY = { itemVisiblePercentThreshold: 0 };

interface ChapterContent {
  id: string;
  title: string;
  content: string;
  number: number;
}

export default function ReaderScreen() {
  const { bookId, jumpChapter, jumpParagraph } = useLocalSearchParams<{
    bookId: string;
    jumpChapter?: string;
    jumpParagraph?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [index, setIndex] = useState(0);
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<{ paragraphIndex: number; text: string } | null>(
    null,
  );
  const [noteMode, setNoteMode] = useState<'highlight' | 'note'>('highlight');
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<BookSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [askMode, setAskMode] = useState<'search' | 'ask'>('search');
  const [askQuestion, setAskQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState<{ question: string; result: BookAnswer } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [noteColor, setNoteColor] = useState<HighlightColor>('gold');

  const {
    scrollRef, pendingScrollRef, pendingParagraphRef, pendingParagraphChapterRef,
    paragraphCountRef, ratioRef, chapterIdRef, cancelSettle, cancelParagraphJump,
    flushProgress, tryJumpToParagraph, handleScroll, handleContentSize, handleLayout,
    handleUserScroll, handleScrollToIndexFailed, handleCellLayout, handleViewableItemsChanged, resetMetrics,
  } = useReaderPosition(bookId);
  const pendingSearchRef = useRef<{ chapterId: string; needle: string } | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  useEffect(() => () => {
    if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
  }, []);

  const theme = READER_THEMES[settings.theme];

  // ── initial load: book, chapters, saved position, settings ────────────────

  useEffect(() => {
    if (!bookId) return;
    void (async () => {
      try {
        const [bookData, chaptersData, progress, settingsRaw, notesData] = await Promise.all([
          api.get<Book>(`/api/books/${bookId}`),
          api.get<ChapterSummary[]>(`/api/books/${bookId}/chapters`),
          getReadingProgress(bookId),
          AsyncStorage.getItem(SETTINGS_KEY),
          getReaderNotes(bookId),
        ]);

        setNotes(notesData);

        if (settingsRaw) {
          try {
            setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(settingsRaw) as Partial<ReaderSettings>) });
          } catch {
            // keep defaults
          }
        }

        setSettingsLoaded(true);
        setBook(bookData);
        setChapters(chaptersData);

        if (chaptersData.length === 0) {
          setError(
            bookData.status === 'processing'
              ? 'This book is still being processed — check back in a minute.'
              : 'This book has no readable chapters yet.',
          );
          setLoading(false);
          return;
        }

        let startIndex = 0;
        if (progress?.chapter_id) {
          const found = chaptersData.findIndex((entry) => entry.id === progress.chapter_id);
          if (found >= 0) startIndex = found;
        }
        // Deep link from the notes screens: open on a specific passage.
        if (jumpChapter) {
          const found = chaptersData.findIndex((entry) => entry.id === jumpChapter);
          if (found >= 0) {
            startIndex = found;
            pendingParagraphChapterRef.current = jumpChapter;
            const paragraph = Number(jumpParagraph);
            if (Number.isInteger(paragraph) && paragraph >= 0) {
              pendingParagraphRef.current = paragraph;
            }
          }
        }
        const savedChapterMatches = progress?.chapter_id === chaptersData[startIndex]?.id;
        const resumeRatio = savedChapterMatches ? (progress?.offset_ratio ?? 0) : 0;
        ratioRef.current = jumpChapter && pendingParagraphRef.current !== null ? 0 : resumeRatio;
        pendingScrollRef.current =
          jumpChapter && pendingParagraphRef.current !== null ? null : resumeRatio;
        setIndex(startIndex);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open this book.');
        setLoading(false);
      }
    })();
  }, [bookId, jumpChapter, jumpParagraph, pendingParagraphChapterRef, pendingParagraphRef, pendingScrollRef, ratioRef]);

  // ── load the current chapter's text ───────────────────────────────────────

  useEffect(() => {
    const summary = chapters[index];
    if (!summary) return;
    if (chapter?.id === summary.id) return; // already on screen — do not refetch
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      setLoadingChapter(true);
      try {
        const data = await api.get<ChapterContent & { content: string }>(
          `/api/chapters/${summary.id}`,
        );
        if (cancelled) return;
        // A search result waiting for this chapter: land on its paragraph.
        const pendingSearch = pendingSearchRef.current;
        if (pendingSearch && pendingSearch.chapterId === data.id) {
          pendingSearchRef.current = null;
          const needle = pendingSearch.needle.toLowerCase();
          const blocks = splitParagraphs(data.content);
          const found = blocks.findIndex((block) => block.toLowerCase().includes(needle));
          if (found >= 0) {
            pendingParagraphRef.current = found;
            pendingParagraphChapterRef.current = data.id;
          }
        }
        setChapter({
          id: data.id,
          title: data.title,
          content: data.content,
          number: data.number,
        });
        resetMetrics();
        chapterIdRef.current = data.id;
        paragraphCountRef.current = splitParagraphs(data.content).length;
        setError(null);
        setLoading(false);
        // Retry after the virtualized list has mounted its initial rows.
        setTimeout(() => tryJumpToParagraph(), 60);
        setTimeout(() => tryJumpToParagraph(), 320);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load this chapter.');
          setLoading(false);
        }
      } finally {
        if (!cancelled) setLoadingChapter(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chapters, index, chapter?.id, tryJumpToParagraph, chapterIdRef, paragraphCountRef, pendingParagraphChapterRef, pendingParagraphRef, resetMetrics]);

  // ── persist settings ──────────────────────────────────────────────────────

  useEffect(() => {
    if (settingsLoaded) {
      void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
    }
  }, [settings, settingsLoaded]);

  const jumpToChapter = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= chapters.length) return;
    flushProgress();
    ratioRef.current = 0;
    pendingScrollRef.current = 0;
    cancelSettle();
    cancelParagraphJump();
    setChaptersOpen(false);
    setIndex(nextIndex);
    if (nextIndex === index) {
      scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
    } else {
      chapterIdRef.current = null;
    }
  };

  // ── highlights & notes ────────────────────────────────────────────────────

  const paragraphs = useMemo(() => splitParagraphs(chapter?.content ?? ''), [chapter?.content]);
  const notesByParagraph = useMemo(() => {
    const map = new Map<number, ReaderNote[]>();
    for (const note of notes) {
      if (note.chapter_id !== chapter?.id) continue;
      const marks = map.get(note.paragraph_index) ?? [];
      marks.push(note);
      map.set(note.paragraph_index, marks);
    }
    return map;
  }, [notes, chapter?.id]);

  const openPassageActions = useCallback((paragraphIndex: number, text: string) => {
    setActionTarget({ paragraphIndex, text });
    setNoteMode('highlight');
    setNoteDraft('');
    setNoteColor('gold');
  }, []);

  const tintForParagraph = (marksList: ReaderNote[]) => {
    const key = marksList[0]?.color ?? 'gold';
    const palette =
      (HIGHLIGHT_TINTS as Record<string, Record<ThemeName, string>>)[key] ?? HIGHLIGHT_TINTS.gold;
    return palette[settings.theme];
  };

  const jumpToNote = (note: ReaderNote) => {
    const target = chapters.findIndex((entry) => entry.id === note.chapter_id);
    setNotesOpen(false);
    if (target < 0) return;
    cancelParagraphJump();
    pendingParagraphRef.current = note.paragraph_index;
    pendingParagraphChapterRef.current = note.chapter_id;
    if (target !== index) {
      flushProgress();
      ratioRef.current = 0;
      chapterIdRef.current = null;
      pendingScrollRef.current = null;
      cancelSettle();
      setIndex(target);
    } else {
      tryJumpToParagraph();
    }
  };

  const saveNote = async (kind: 'highlight' | 'note') => {
    if (!actionTarget || !chapter || !bookId) return;
    if (kind === 'note' && !noteDraft.trim()) return;
    setSavingNote(true);
    try {
      const saved = await addReaderNote(bookId, {
        chapterId: chapter.id,
        paragraphIndex: actionTarget.paragraphIndex,
        kind,
        color: noteColor,
        text: actionTarget.text.slice(0, 2000),
        ...(kind === 'note' ? { note: noteDraft.trim() } : {}),
      });
      // The POST response carries no chapter join — fill it in for the drawer.
      setNotes((current) => [
        ...current,
        { ...saved, chapter_number: chapter.number, chapter_title: chapter.title },
      ]);
      setActionTarget(null);
      setNoteDraft('');
    } catch {
      // Keep the sheet open so the student can retry.
    } finally {
      setSavingNote(false);
    }
  };

  const removeNote = async (noteId: string) => {
    setNotes((current) => current.filter((entry) => entry.id !== noteId));
    await deleteReaderNote(noteId).catch(() => {});
  };

  // ── in-book search ────────────────────────────────────────────────────────

  const runSearch = async (text: string) => {
    if (!bookId) return;
    const seq = ++searchSeqRef.current;
    setSearching(true);
    try {
      const results = await searchBook(bookId, text);
      if (seq === searchSeqRef.current) setSearchResults(results);
    } catch {
      if (seq === searchSeqRef.current) setSearchResults([]);
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  };

  const handleSearchText = (text: string) => {
    setSearchQuery(text);
    if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
    const trimmed = text.trim();
    if (trimmed.length < 2) {
      searchSeqRef.current += 1; // cancel anything in flight
      setSearchResults(null);
      setSearching(false);
      return;
    }
    searchTimerRef.current = setTimeout(() => void runSearch(trimmed), 450);
  };

  const jumpToSearchHit = (hit: BookSearchHit) => {
    const needle = searchQuery.trim().toLowerCase();
    setSearchOpen(false);
    if (!needle || !bookId) return;
    const targetIndex = chapters.findIndex((entry) => entry.id === hit.chapter_id);
    if (targetIndex < 0) return;
    if (targetIndex !== index) {
      flushProgress();
      chapterIdRef.current = null;
    }
    ratioRef.current = 0;
    pendingScrollRef.current = null;
    cancelSettle();
    cancelParagraphJump();
    if (targetIndex === index && chapter?.id === hit.chapter_id) {
      const blocks = splitParagraphs(chapter?.content ?? '');
      const found = blocks.findIndex((block) => block.toLowerCase().includes(needle));
      if (found >= 0) {
        pendingParagraphRef.current = found;
        pendingParagraphChapterRef.current = hit.chapter_id;
        tryJumpToParagraph();
      }
    } else {
      pendingSearchRef.current = { chapterId: hit.chapter_id, needle };
      setIndex(targetIndex);
    }
  };

  const runAsk = async () => {
    const question = askQuestion.trim();
    if (!bookId || question.length < 4 || asking) return;
    setAsking(true);
    setAskError(null);
    setAskAnswer(null);
    try {
      const result = await askBook(bookId, question);
      setAskAnswer({ question, result });
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'Could not answer that right now.');
    } finally {
      setAsking(false);
    }
  };

  const jumpToSource = (chapterId: string) => {
    const targetIndex = chapters.findIndex((entry) => entry.id === chapterId);
    setSearchOpen(false);
    if (targetIndex < 0) return;
    jumpToChapter(targetIndex);
  };

  // ── rendering ─────────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingView label="Opening the book…" />;
  }

  if (!book || error || chapters.length === 0) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bg, paddingLeft: insets.left, paddingRight: insets.right }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StatusBar style={settings.theme === 'dark' ? 'light' : 'dark'} />
        <View style={[styles.topBar, { backgroundColor: theme.chrome, borderColor: theme.border, paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.iconButton} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={22} color={theme.text} />
          </Pressable>
          <Text style={[styles.topTitle, { color: theme.text }]} numberOfLines={1}>
            {book?.title ?? 'Reader'}
          </Text>
          <View style={styles.iconButton} />
        </View>
        <View style={styles.centerBox}>
          <Text style={{ color: theme.muted, textAlign: 'center' }}>
            {error ?? 'Nothing to read here yet.'}
          </Text>
        </View>
      </View>
    );
  }

  const lineHeight = Math.round(settings.fontSize * LINE_HEIGHTS[settings.spacing]);
  const serifFamily = settings.serif
    ? Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' })
    : undefined;

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar style={settings.theme === 'dark' ? 'light' : 'dark'} />

      {/* Top bar */}
      <View style={[styles.topBar, { backgroundColor: theme.chrome, borderColor: theme.border, paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.iconButton} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={22} color={theme.text} />
        </Pressable>
        <Pressable style={styles.topCenter} onPress={() => setChaptersOpen(true)}>
          <Text style={[styles.topTitle, { color: theme.text }]} numberOfLines={1}>
            {book.title}
          </Text>
          <Text style={[styles.topSubtitle, { color: theme.muted }]} numberOfLines={1}>
            {chapter?.title ?? `Chapter ${index + 1}`}
          </Text>
        </Pressable>
        <Pressable style={styles.iconButton} onPress={() => setSearchOpen(true)}>
          <Ionicons name="search-outline" size={19} color={theme.text} />
        </Pressable>
        <Pressable style={styles.iconButton} onPress={() => setNotesOpen(true)}>
          <Ionicons name="bookmark-outline" size={19} color={theme.text} />
          {notes.length > 0 ? (
            <View style={styles.notesBadge}>
              <Text style={styles.notesBadgeText}>{notes.length > 99 ? '99+' : notes.length}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable style={styles.iconButton} onPress={() => setSettingsOpen(true)}>
          <Ionicons name="text" size={20} color={theme.text} />
        </Pressable>
      </View>

      {/* FlatList mounts a bounded window of paragraphs, even for long books. */}
      {loadingChapter ? (
        <View style={styles.centerBox}>
          <ActivityIndicator color={theme.muted} />
          <Text style={{ color: theme.muted }}>Loading chapter...</Text>
        </View>
      ) : (
        <ReaderCellLayoutContext.Provider value={handleCellLayout}>
        <FlatList
          key={chapter?.id}
          ref={scrollRef}
          data={paragraphs}
          CellRendererComponent={ReaderCell}
          keyExtractor={(_paragraph, paragraphIndex) => String(paragraphIndex)}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={7}
          style={styles.flex}
          contentContainerStyle={styles.readingContent}
          onScroll={handleScroll}
          onScrollBeginDrag={handleUserScroll}
          onTouchMove={handleUserScroll}
          {...(Platform.OS === 'web' ? {
            onWheel: handleUserScroll,
            onKeyDown: (event: { key: string }) => {
              if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
                handleUserScroll();
              }
            },
          } : {})}
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={READER_VIEWABILITY}
          scrollEventThrottle={64}
          onContentSizeChange={handleContentSize}
          onLayout={handleLayout}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            <Text style={[styles.chapterHeading, {
              color: theme.text, fontFamily: serifFamily, fontSize: settings.fontSize + 8,
            }]}>
              {chapter?.title ?? `Chapter ${index + 1}`}
            </Text>
          }
          renderItem={({ item: paragraph, index: paragraphIndex }) => {
            const marks = notesByParagraph.get(paragraphIndex) ?? [];
            const highlights = marks.filter((entry) => entry.kind === 'highlight');
            return (
              <ReaderParagraph
                text={paragraph}
                index={paragraphIndex}
                color={theme.text}
                tint={highlights.length ? tintForParagraph(highlights) : undefined}
                noted={marks.some((entry) => entry.kind === 'note')}
                fontFamily={serifFamily}
                fontSize={settings.fontSize}
                lineHeight={lineHeight}
                onLongPress={openPassageActions}
              />
            );
          }}
          ListFooterComponent={
            <View style={[styles.chapterEnd, { borderColor: theme.border }]}>
              <Text style={{ color: theme.muted, marginBottom: spacing.md }}>
                {index + 1 < chapters.length
                  ? `End of \u201c${chapter?.title ?? ''}\u201d`
                  : 'You finished the last chapter \ud83c\udf89'}
              </Text>
              {index + 1 < chapters.length ? (
                <Pressable
                  style={[styles.nextChapterButton, { backgroundColor: theme.chrome, borderColor: theme.border }]}
                  onPress={() => jumpToChapter(index + 1)}
                >
                  <Text style={{ color: theme.text, fontWeight: '700' }}>
                    Next: {chapters[index + 1]?.title ?? 'Chapter'}
                  </Text>
                  <Ionicons name="arrow-forward" size={16} color={theme.text} />
                </Pressable>
              ) : null}
            </View>
          }
        />
        </ReaderCellLayoutContext.Provider>
      )}

      {/* Bottom chapter bar */}
      <View style={[styles.bottomBar, { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 8 }]}>
        <Pressable
          style={[styles.navButton, index === 0 && styles.navDisabled]}
          disabled={index === 0}
          onPress={() => jumpToChapter(index - 1)}
        >
          <Ionicons name="chevron-back" size={16} color={index === 0 ? theme.muted : theme.text} />
          <Text style={{ color: index === 0 ? theme.muted : theme.text, fontWeight: '600' }}>Prev</Text>
        </Pressable>
        <Pressable style={styles.positionLabel} onPress={() => setChaptersOpen(true)}>
          <Text style={{ color: theme.muted, fontSize: 13 }}>
            {index + 1} / {chapters.length}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.navButton, index >= chapters.length - 1 && styles.navDisabled]}
          disabled={index >= chapters.length - 1}
          onPress={() => jumpToChapter(index + 1)}
        >
          <Text
            style={{ color: index >= chapters.length - 1 ? theme.muted : theme.text, fontWeight: '600' }}
          >
            Next
          </Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={index >= chapters.length - 1 ? theme.muted : theme.text}
          />
        </Pressable>
      </View>

      {/* Settings sheet */}
      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSettingsOpen(false)} />
        <View style={[styles.sheet, { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 20, paddingLeft: Math.max(insets.left, 20), paddingRight: Math.max(insets.right, 20) }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Reading settings</Text>

          <Text style={[styles.settingLabel, { color: theme.muted }]}>Theme</Text>
          <View style={styles.settingRow}>
            {(Object.keys(READER_THEMES) as ThemeName[]).map((name) => (
              <Pressable
                key={name}
                onPress={() => setSettings((current) => ({ ...current, theme: name }))}
                style={[
                  styles.themeSwatch,
                  { backgroundColor: READER_THEMES[name].bg, borderColor: settings.theme === name ? '#6D8BFF' : theme.border },
                ]}
              >
                <Text style={{ color: READER_THEMES[name].text, fontWeight: '600', fontSize: 12 }}>
                  {name === 'dark' ? 'Dark' : name === 'sepia' ? 'Sepia' : 'Light'}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.settingLabel, { color: theme.muted }]}>Text size</Text>
          <View style={styles.settingRow}>
            <Pressable
              style={[styles.stepButton, { borderColor: theme.border }]}
              onPress={() =>
                setSettings((current) => ({ ...current, fontSize: Math.max(14, current.fontSize - 1) }))
              }
            >
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }}>A−</Text>
            </Pressable>
            <Text style={{ color: theme.text, fontWeight: '700', fontSize: 17 }}>{settings.fontSize}</Text>
            <Pressable
              style={[styles.stepButton, { borderColor: theme.border }]}
              onPress={() =>
                setSettings((current) => ({ ...current, fontSize: Math.min(32, current.fontSize + 1) }))
              }
            >
              <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>A+</Text>
            </Pressable>
          </View>

          <Text style={[styles.settingLabel, { color: theme.muted }]}>Line spacing</Text>
          <View style={styles.settingRow}>
            {(['cozy', 'normal', 'airy'] as Spacing[]).map((spacingName) => (
              <Pressable
                key={spacingName}
                onPress={() => setSettings((current) => ({ ...current, spacing: spacingName }))}
                style={[
                  styles.choiceChip,
                  {
                    borderColor: settings.spacing === spacingName ? '#6D8BFF' : theme.border,
                    backgroundColor: settings.spacing === spacingName ? 'rgba(109,139,255,0.16)' : 'transparent',
                  },
                ]}
              >
                <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600', textTransform: 'capitalize' }}>
                  {spacingName}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.settingLabel, { color: theme.muted }]}>Typeface</Text>
          <View style={styles.settingRow}>
            {[false, true].map((serif) => (
              <Pressable
                key={serif ? 'serif' : 'sans'}
                onPress={() => setSettings((current) => ({ ...current, serif }))}
                style={[
                  styles.choiceChip,
                  {
                    borderColor: settings.serif === serif ? '#6D8BFF' : theme.border,
                    backgroundColor: settings.serif === serif ? 'rgba(109,139,255,0.16)' : 'transparent',
                  },
                ]}
              >
                <Text
                  style={{
                    color: theme.text,
                    fontSize: 14,
                    fontWeight: '600',
                    fontFamily: serif
                      ? Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' })
                      : undefined,
                  }}
                >
                  {serif ? 'Serif' : 'Sans'}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            style={[styles.doneButton, { borderColor: theme.border }]}
            onPress={() => setSettingsOpen(false)}
          >
            <Text style={{ color: theme.text, fontWeight: '700' }}>Done</Text>
          </Pressable>
        </View>
      </Modal>

      {/* Chapter drawer */}
      <Modal visible={chaptersOpen} transparent animationType="slide" onRequestClose={() => setChaptersOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setChaptersOpen(false)} />
        <View style={[styles.sheet, styles.chapterSheet, { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 20, paddingLeft: Math.max(insets.left, 20), paddingRight: Math.max(insets.right, 20) }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Chapters</Text>
          <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
            {chapters.map((entry, entryIndex) => {
              const active = entryIndex === index;
              return (
                <Pressable
                  key={entry.id}
                  onPress={() => jumpToChapter(entryIndex)}
                  style={[styles.chapterRow, { borderColor: theme.border }]}
                >
                  <Text style={{ color: theme.muted, width: 34 }}>{entry.number}</Text>
                  <Text
                    style={{ color: theme.text, flex: 1, fontWeight: active ? '800' : '500' }}
                    numberOfLines={2}
                  >
                    {entry.title}
                  </Text>
                  {active ? <Ionicons name="bookmark" size={16} color="#6D8BFF" /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Modal>

      {/* Passage actions (long-press) */}
      <Modal
        visible={actionTarget !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setActionTarget(null)} />
        <View style={[styles.sheet, { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 20, paddingLeft: Math.max(insets.left, 20), paddingRight: Math.max(insets.right, 20) }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>
            {noteMode === 'note' ? 'Add a note' : 'Save this passage'}
          </Text>
          <Text
            style={[styles.passagePreview, { color: theme.muted, borderColor: theme.border }]}
            numberOfLines={4}
          >
            {actionTarget?.text.slice(0, 260) ?? ''}
          </Text>
          <View style={styles.colorRow}>
            {HIGHLIGHT_COLOR_KEYS.map((key) => (
              <Pressable
                key={key}
                onPress={() => setNoteColor(key)}
                style={[
                  styles.colorDot,
                  { backgroundColor: HIGHLIGHT_DOTS[key] },
                  noteColor === key && { borderColor: theme.text, borderWidth: 2 },
                ]}
              />
            ))}
          </View>
          {noteMode === 'note' ? (
            <TextInput
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder="Write your note…"
              placeholderTextColor={theme.muted}
              multiline
              autoFocus
              style={[styles.noteInput, { color: theme.text, borderColor: theme.border }]}
            />
          ) : null}
          <View style={styles.settingRow}>
            {noteMode !== 'note' ? (
              <>
                <Pressable
                  style={[
                    styles.choiceChip,
                    { borderColor: '#D2921F', backgroundColor: 'rgba(210,146,31,0.18)' },
                  ]}
                  disabled={savingNote}
                  onPress={() => void saveNote('highlight')}
                >
                  <Text style={{ color: theme.text, fontWeight: '700' }}>📍 Highlight</Text>
                </Pressable>
                <Pressable
                  style={[styles.choiceChip, { borderColor: theme.border }]}
                  onPress={() => setNoteMode('note')}
                >
                  <Text style={{ color: theme.text, fontWeight: '600' }}>📝 Add a note</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Pressable
                  style={[
                    styles.choiceChip,
                    { borderColor: '#6D8BFF', backgroundColor: 'rgba(109,139,255,0.16)' },
                  ]}
                  disabled={savingNote || !noteDraft.trim()}
                  onPress={() => void saveNote('note')}
                >
                  <Text style={{ color: theme.text, fontWeight: '700' }}>
                    {savingNote ? 'Saving…' : 'Save note'}
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.choiceChip, { borderColor: theme.border }]}
                  onPress={() => setNoteMode('highlight')}
                >
                  <Text style={{ color: theme.muted, fontWeight: '600' }}>Back</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* In-book search */}
      <Modal visible={searchOpen} transparent animationType="slide" onRequestClose={() => setSearchOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSearchOpen(false)} />
        <View style={[styles.sheet, styles.chapterSheet, { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 20, paddingLeft: Math.max(insets.left, 20), paddingRight: Math.max(insets.right, 20) }]}>
          <View style={styles.modeRow}>
            <Pressable
              style={[
                styles.modeChip,
                { borderColor: theme.border },
                askMode === 'search' && styles.modeChipActive,
              ]}
              onPress={() => setAskMode('search')}
            >
              <Text style={{ color: askMode === 'search' ? theme.text : theme.muted, fontWeight: '700' }}>
                🔎 Search
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.modeChip,
                { borderColor: theme.border },
                askMode === 'ask' && styles.modeChipActive,
              ]}
              onPress={() => setAskMode('ask')}
            >
              <Text style={{ color: askMode === 'ask' ? theme.text : theme.muted, fontWeight: '700' }}>
                ✨ Ask Athena
              </Text>
            </Pressable>
          </View>
          {askMode === 'search' ? (
            <>
              <TextInput
                value={searchQuery}
                onChangeText={handleSearchText}
                placeholder="Type at least 2 letters..."
                placeholderTextColor={theme.muted}
                autoFocus
                autoCorrect={false}
                style={[styles.noteInput, styles.searchInput, { color: theme.text, borderColor: theme.border }]}
              />
              {searching ? <ActivityIndicator color={theme.muted} style={{ paddingVertical: 14 }} /> : null}
              {!searching && searchResults !== null ? (
                searchResults.length === 0 ? (
                  <Text style={{ color: theme.muted, paddingVertical: 12, lineHeight: 20 }}>
                    No matches for “{searchQuery.trim()}”.
                  </Text>
                ) : (
                  <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
                    {searchResults.map((hit) => (
                      <Pressable
                        key={hit.chapter_id}
                        style={[styles.noteRow, { borderColor: theme.border }]}
                        onPress={() => jumpToSearchHit(hit)}
                      >
                        <View style={styles.flex}>
                          <Text style={{ color: theme.muted, fontSize: 11, fontWeight: '700' }}>
                            Ch. {hit.number} · {hit.title}
                            {hit.hits > 1 ? ` · ${hit.hits} matches` : ''}
                          </Text>
                          <Text style={{ color: theme.text, marginTop: 4, lineHeight: 20 }} numberOfLines={2}>
                            {hit.snippet.replace(/\s+/g, ' ').trim()}
                          </Text>
                        </View>
                        <Ionicons name="arrow-forward" size={16} color={theme.muted} />
                      </Pressable>
                    ))}
                  </ScrollView>
                )
              ) : null}
              {!searching && searchResults === null ? (
                <Text style={{ color: theme.muted, paddingVertical: 12, lineHeight: 20 }}>
                  Find a word or phrase anywhere in the book — results jump straight to the passage.
                </Text>
              ) : null}
            </>
          ) : (
            <>
              <TextInput
                value={askQuestion}
                onChangeText={(text) => {
                  setAskQuestion(text);
                  setAskAnswer(null);
                  setAskError(null);
                }}
                editable={!asking}
                placeholder="e.g. How does the cardiac cycle relate to the ECG?"
                placeholderTextColor={theme.muted}
                multiline
                style={[styles.noteInput, { color: theme.text, borderColor: theme.border }]}
              />
              <Pressable
                style={[
                  styles.choiceChip,
                  { borderColor: '#6D8BFF', backgroundColor: 'rgba(109,139,255,0.16)', alignItems: 'center' },
                ]}
                disabled={asking || askQuestion.trim().length < 4}
                onPress={() => void runAsk()}
              >
                <Text style={{ color: theme.text, fontWeight: '700' }}>
                  {asking ? 'Reading the book… (up to ~30s)' : 'Ask Athena'}
                </Text>
              </Pressable>
              {asking ? <ActivityIndicator color={theme.muted} style={{ paddingVertical: 10 }} /> : null}
              {askError && !asking ? (
                <Text style={{ color: '#E5484D', lineHeight: 20 }}>{askError}</Text>
              ) : null}
              {askAnswer && !asking ? (
                <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
                  <Text style={{ color: theme.muted, fontWeight: '700', marginBottom: 8 }}>
                    Asked: {askAnswer.question}
                  </Text>
                  <Text style={{ color: theme.text, lineHeight: 22, marginTop: 4 }}>
                    {askAnswer.result.answer}
                  </Text>
                  {askAnswer.result.sources.length > 0 ? (
                    <View style={styles.sourceRow}>
                      <Text style={{ color: theme.muted, fontSize: 11, fontWeight: '700' }}>From</Text>
                      {askAnswer.result.sources.map((source) => (
                        <Pressable
                          key={source.chapter_id}
                          style={[styles.sourceChip, { borderColor: theme.border }]}
                          onPress={() => jumpToSource(source.chapter_id)}
                        >
                          <Text style={{ color: theme.text, fontSize: 12, fontWeight: '600' }}>
                            Ch. {source.number}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  <Text style={{ color: theme.muted, fontSize: 11, marginTop: 10, lineHeight: 16 }}>
                    Answers come only from this book’s text — always double-check clinical details.
                  </Text>
                </ScrollView>
              ) : null}
              {!askAnswer && !asking && !askError ? (
                <Text style={{ color: theme.muted, paddingVertical: 6, lineHeight: 20 }}>
                  Ask anything about this book. Athena answers from the book’s own text and cites
                  the chapters it used — tap a citation to jump there.
                </Text>
              ) : null}
            </>
          )}
        </View>
      </Modal>

      {/* Notes & highlights drawer */}
      <Modal visible={notesOpen} transparent animationType="slide" onRequestClose={() => setNotesOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNotesOpen(false)} />
        <View style={[styles.sheet, styles.chapterSheet, { backgroundColor: theme.chrome, borderColor: theme.border, paddingBottom: insets.bottom + 20, paddingLeft: Math.max(insets.left, 20), paddingRight: Math.max(insets.right, 20) }]}>
          <View style={styles.drawerHeader}>
            <Text style={[styles.sheetTitle, { color: theme.text }]}>
              Notes & highlights{notes.length > 0 ? ` (${notes.length})` : ''}
            </Text>
            {notes.length > 0 ? (
              <Pressable
                style={styles.noteDelete}
                onPress={() => void exportNotesMarkdown(book.title, notes)}
              >
                <Ionicons name="share-outline" size={18} color={theme.muted} />
              </Pressable>
            ) : null}
          </View>
          {notes.length === 0 ? (
            <Text style={{ color: theme.muted, paddingVertical: 12, lineHeight: 20 }}>
              Long-press any passage while reading to highlight it or attach a note.
            </Text>
          ) : (
            <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
              {notes.map((entry) => (
                <View key={entry.id} style={[styles.noteRow, { borderColor: theme.border }]}>
                  <Pressable style={styles.flex} onPress={() => jumpToNote(entry)}>
                    <View style={styles.noteMetaRow}>
                      <View
                        style={[
                          styles.noteDot,
                          {
                            backgroundColor:
                              HIGHLIGHT_DOTS[(entry.color ?? 'gold') as HighlightColor] ??
                              HIGHLIGHT_DOTS.gold,
                          },
                        ]}
                      />
                      <Text style={{ color: theme.muted, fontSize: 11, fontWeight: '700' }}>
                        Ch. {entry.chapter_number} · {entry.chapter_title}
                      </Text>
                    </View>
                    {entry.kind === 'note' && entry.note ? (
                      <Text style={{ color: theme.text, marginTop: 4, lineHeight: 20 }}>
                        {entry.note}
                      </Text>
                    ) : null}
                    {entry.text ? (
                      <Text
                        style={{
                          color: entry.kind === 'highlight' ? theme.text : theme.muted,
                          marginTop: 4,
                          fontStyle: 'italic',
                          lineHeight: 20,
                        }}
                        numberOfLines={entry.kind === 'highlight' ? 4 : 3}
                      >
                        “{entry.text}”
                      </Text>
                    ) : null}
                  </Pressable>
                  <Pressable onPress={() => void removeNote(entry.id)} style={styles.noteDelete}>
                    <Ionicons name="trash-outline" size={16} color={theme.muted} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

/** Splits chapter text into reader paragraphs (blank-line aware). */
function splitParagraphs(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const blocks = trimmed.split(/\n{2,}/);
  if (blocks.length >= 3) {
    return blocks.map((block) => block.replace(/\n/g, ' ').trim()).filter((block) => block.length > 0);
  }
  return trimmed
    .split(/\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  topCenter: { flex: 1, alignItems: 'center' },
  topTitle: { fontSize: 14, fontWeight: '700', maxWidth: '90%' },
  topSubtitle: { fontSize: 11, marginTop: 1, maxWidth: '90%' },
  iconButton: { width: 44, height: 36, alignItems: 'center', justifyContent: 'center' },
  readingContent: {
    paddingHorizontal: 22,
    paddingTop: 26,
    paddingBottom: 48,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  chapterHeading: { fontWeight: '800', marginBottom: 22 },
  chapterEnd: { marginTop: 26, paddingTop: 20, borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  nextChapterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    maxWidth: '100%',
  },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingBottom: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  navButton: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 8 },
  navDisabled: { opacity: 0.55 },
  positionLabel: { padding: 8 },
  centerBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    paddingBottom: 20,
    gap: 10,
  },
  chapterSheet: { maxHeight: '70%' },
  sheetTitle: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  settingLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 6 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  themeSwatch: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButton: {
    width: 56,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceChip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  doneButton: {
    marginTop: 10,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  chapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  notesBadge: {
    position: 'absolute',
    top: 2,
    right: 6,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#D2921F',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  notesBadgeText: { color: '#1A1206', fontSize: 10, fontWeight: '800' },
  highlightedParagraph: {
    borderRadius: 8,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    paddingTop: 4,
    marginTop: -4,
  },
  passagePreview: {
    fontStyle: 'italic',
    lineHeight: 22,
    borderLeftWidth: 3,
    paddingLeft: 10,
    marginBottom: 4,
  },
  noteInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    minHeight: 90,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  noteRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  noteDelete: { padding: 8 },
  searchInput: { minHeight: 46, paddingVertical: 10 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1 },
  modeChipActive: { borderColor: '#6D8BFF', backgroundColor: 'rgba(109,139,255,0.16)' },
  sourceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 10, gap: 6 },
  sourceChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  colorRow: { flexDirection: 'row', gap: 12, paddingVertical: 2 },
  colorDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  drawerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  noteMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noteDot: { width: 8, height: 8, borderRadius: 4 },
});
