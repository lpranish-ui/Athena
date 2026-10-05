// The reader — a distraction-free way to actually read the books in Athena.
//
// Full text comes from the stored chapters (no re-parsing on the phone).
// The reading position is saved to the server (chapter + scroll ratio) so
// you resume exactly where you left off on any device.

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { LoadingView } from '@/components/ui';
import {
  addReaderNote,
  deleteReaderNote,
  getReaderNotes,
  getReadingProgress,
  saveReadingProgress,
  searchBook,
  type BookSearchHit,
  type ReaderNote,
} from '@/lib/api';
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

/** Soft gold tint behind highlighted passages, per theme. */
const HIGHLIGHT_TINTS: Record<ThemeName, string> = {
  dark: 'rgba(216,154,40,0.22)',
  sepia: 'rgba(216,154,40,0.30)',
  light: 'rgba(216,154,40,0.20)',
};

// Clock read kept at module scope — it runs from scroll callbacks, never
// during render, but the React compiler's purity rule is conservative.
const nowMs: () => number = Date.now.bind(Date);

interface ReaderSettings {
  theme: ThemeName;
  fontSize: number;
  spacing: Spacing;
  serif: boolean;
}

const SETTINGS_KEY = 'athena.reader.settings';
const DEFAULT_SETTINGS: ReaderSettings = { theme: 'dark', fontSize: 18, spacing: 'normal', serif: false };

interface ChapterContent {
  id: string;
  title: string;
  content: string;
  number: number;
}

export default function ReaderScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const router = useRouter();

  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [index, setIndex] = useState(0);
  const [chapter, setChapter] = useState<ChapterContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
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

  const scrollRef = useRef<ScrollView>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const pendingParagraphRef = useRef<number | null>(null);
  const pendingParagraphChapterRef = useRef<string | null>(null);
  const paragraphJumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paragraphLayoutsRef = useRef<Map<number, number>>(new Map());
  const contentHeightRef = useRef(0);
  const layoutHeightRef = useRef(0);
  const ratioRef = useRef(0);
  const chapterIdRef = useRef<string | null>(null);
  const lastSaveRef = useRef(0);
  const suppressScrollRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSearchRef = useRef<{ chapterId: string; needle: string } | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  // Stop re-applying the saved position (user took over, or a new jump).
  const cancelSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  // Drop any pending jump-to-paragraph target.
  const cancelParagraphJump = useCallback(() => {
    if (paragraphJumpTimerRef.current !== null) {
      clearTimeout(paragraphJumpTimerRef.current);
      paragraphJumpTimerRef.current = null;
    }
    pendingParagraphRef.current = null;
    pendingParagraphChapterRef.current = null;
  }, []);

  /** Offset of one paragraph inside the scroll content. Web measures the DOM
   *  on demand (initial onLayout never fires there); native uses the layout
   *  map, which RN fills reliably. Returns null when not measurable yet. */
  const measureParagraph = useCallback((paragraphIndex: number): number | null => {
    if (Platform.OS === 'web') {
      type DomBox = { getBoundingClientRect: () => { top: number }; scrollTop: number };
      const scroller = (scrollRef.current as unknown as { getScrollableNode?: () => DomBox | null } | null)?.getScrollableNode?.();
      const doc = (globalThis as { document?: { querySelector: (selector: string) => DomBox | null } }).document;
      const el = doc?.querySelector(`[data-pidx="${paragraphIndex}"]`);
      if (!scroller || !el) return null;
      return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    }
    const y = paragraphLayoutsRef.current.get(paragraphIndex);
    return y === undefined ? null : y;
  }, []);

  const tryJumpToParagraph = useCallback(() => {
    const target = pendingParagraphRef.current;
    if (target === null) return;
    // The jump belongs to one chapter — ignore layouts of any other chapter.
    const targetChapter = pendingParagraphChapterRef.current;
    if (targetChapter !== null && targetChapter !== chapterIdRef.current) return;
    const y = measureParagraph(target);
    if (y === null) return;
    // The precise paragraph position wins over any resume re-apply.
    cancelSettle();
    pendingScrollRef.current = null;
    suppressScrollRef.current = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: false });
    // Keep re-applying while the layout settles, then let go — a real user
    // scroll (or another jump) cancels it first.
    if (paragraphJumpTimerRef.current === null) {
      paragraphJumpTimerRef.current = setTimeout(() => {
        paragraphJumpTimerRef.current = null;
        pendingParagraphRef.current = null;
        pendingParagraphChapterRef.current = null;
      }, 900);
    }
  }, [cancelSettle, measureParagraph]);

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
        pendingScrollRef.current = progress?.offset_ratio ?? 0;
        setIndex(startIndex);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open this book.');
        setLoading(false);
      }
    })();
  }, [bookId]);

  // ── load the current chapter's text ───────────────────────────────────────

  useEffect(() => {
    const summary = chapters[index];
    if (!summary) return;
    if (chapter?.id === summary.id) return; // already on screen — do not refetch
    let cancelled = false;
    paragraphLayoutsRef.current = new Map();
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
        chapterIdRef.current = data.id;
        setLoading(false);
        // Web paragraphs have no layout events until they resize — give the
        // DOM a beat, then measure and jump to whatever is pending.
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
  }, [chapters, index, chapter?.id, tryJumpToParagraph]);

  // ── persist settings ──────────────────────────────────────────────────────

  useEffect(() => {
    void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)).catch(() => {});
  }, [settings]);

  // ── progress saving ───────────────────────────────────────────────────────

  const flushProgress = useCallback(() => {
    if (!bookId || !chapterIdRef.current) return;
    void saveReadingProgress(bookId, chapterIdRef.current, ratioRef.current);
  }, [bookId]);

  useEffect(() => {
    // Save the position when leaving the reader.
    return () => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      if (searchTimerRef.current !== null) clearTimeout(searchTimerRef.current);
      if (paragraphJumpTimerRef.current !== null) clearTimeout(paragraphJumpTimerRef.current);
      flushProgress();
    };
  }, [flushProgress]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;

    // Ignore the scroll events our own restore/jump triggers.
    if (suppressScrollRef.current) {
      suppressScrollRef.current = false;
      return;
    }

    // A real user gesture takes over — stop re-applying the saved position.
    cancelSettle();
    cancelParagraphJump();
    pendingScrollRef.current = null;

    const max = Math.max(1, contentSize.height - layoutMeasurement.height);
    ratioRef.current = Math.min(1, Math.max(0, contentOffset.y / max));

    const now = nowMs();
    if (now - lastSaveRef.current > 2500) {
      lastSaveRef.current = now;
      if (bookId && chapterIdRef.current) {
        void saveReadingProgress(bookId, chapterIdRef.current, ratioRef.current);
      }
    }
  };

  // The chapter text is one huge block — browsers and native views report a
  // final size only after a moment. Re-apply the pending position for a short
  // settle window so the restore sticks; any real user scroll cancels it.
  const applyPendingScroll = () => {
    const pending = pendingScrollRef.current;
    if (pending === null) return;
    if (contentHeightRef.current <= 0 || layoutHeightRef.current <= 0) return;

    const max = Math.max(0, contentHeightRef.current - layoutHeightRef.current);
    suppressScrollRef.current = true;
    scrollRef.current?.scrollTo({ y: pending * max, animated: false });

    // Keep re-applying while the layout settles, then let go — unless the
    // user scrolls first, which cancels the timer in handleScroll.
    if (settleTimerRef.current === null) {
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        pendingScrollRef.current = null;
      }, 1500);
    }
  };

  const handleContentSize = (_width: number, height: number) => {
    contentHeightRef.current = height;
    applyPendingScroll();
    tryJumpToParagraph();
  };

  const jumpToChapter = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= chapters.length) return;
    flushProgress();
    ratioRef.current = 0;
    pendingScrollRef.current = 0;
    cancelSettle();
    cancelParagraphJump();
    setChaptersOpen(false);
    setIndex(nextIndex);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  // ── highlights & notes ────────────────────────────────────────────────────

  const notesForParagraph = (paragraphIndex: number) =>
    notes.filter(
      (entry) => entry.chapter_id === chapter?.id && entry.paragraph_index === paragraphIndex,
    );

  const jumpToNote = (note: ReaderNote) => {
    const target = chapters.findIndex((entry) => entry.id === note.chapter_id);
    setNotesOpen(false);
    if (target < 0) return;
    cancelParagraphJump();
    pendingParagraphRef.current = note.paragraph_index;
    pendingParagraphChapterRef.current = note.chapter_id;
    if (target !== index) {
      flushProgress();
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
      flushProgress();
      pendingSearchRef.current = { chapterId: hit.chapter_id, needle };
      setIndex(targetIndex);
    }
  };

  // ── rendering ─────────────────────────────────────────────────────────────

  if (loading) {
    return <LoadingView label="Opening the book…" />;
  }

  if (!book || error || chapters.length === 0) {
    return (
      <View style={[styles.flex, { backgroundColor: theme.bg }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={[styles.topBar, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
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

  const paragraphs = splitParagraphs(chapter?.content ?? '');
  const lineHeight = Math.round(settings.fontSize * LINE_HEIGHTS[settings.spacing]);
  const serifFamily = settings.serif
    ? Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, serif' })
    : undefined;

  return (
    <View style={[styles.flex, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Top bar */}
      <View style={[styles.topBar, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
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

      {/* The book text */}
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.readingContent}
        onScroll={handleScroll}
        scrollEventThrottle={64}
        onContentSizeChange={handleContentSize}
        onLayout={(event) => {
          layoutHeightRef.current = event.nativeEvent.layout.height;
          applyPendingScroll();
        }}
        showsVerticalScrollIndicator={false}
      >
        {loadingChapter ? (
          <View style={styles.centerBox}>
            <Text style={{ color: theme.muted }}>Loading chapter…</Text>
          </View>
        ) : (
          <>
            <Text
              style={[
                styles.chapterHeading,
                { color: theme.text, fontFamily: serifFamily, fontSize: settings.fontSize + 8 },
              ]}
            >
              {chapter?.title ?? `Chapter ${index + 1}`}
            </Text>
            {paragraphs.map((paragraph, paragraphIndex) => {
              const marks = notesForParagraph(paragraphIndex);
              const highlighted = marks.some((entry) => entry.kind === 'highlight');
              const noted = marks.some((entry) => entry.kind === 'note');
              return (
                <Pressable
                  key={paragraphIndex}
                  {...(Platform.OS === 'web'
                    ? { dataSet: { pidx: String(paragraphIndex) } }
                    : {})}
                  onLongPress={() => {
                    setActionTarget({ paragraphIndex, text: paragraph });
                    setNoteMode('highlight');
                    setNoteDraft('');
                  }}
                  delayLongPress={350}
                  onLayout={(event) => {
                    paragraphLayoutsRef.current.set(paragraphIndex, event.nativeEvent.layout.y);
                    tryJumpToParagraph();
                  }}
                  style={
                    highlighted
                      ? [styles.highlightedParagraph, { backgroundColor: HIGHLIGHT_TINTS[settings.theme] }]
                      : undefined
                  }
                >
                  <Text
                    style={{
                      color: theme.text,
                      fontFamily: serifFamily,
                      fontSize: settings.fontSize,
                      lineHeight,
                      marginBottom: Math.round(lineHeight * 0.55),
                    }}
                  >
                    {paragraph}
                    {noted ? '  📝' : ''}
                  </Text>
                </Pressable>
              );
            })}

            <View style={[styles.chapterEnd, { borderColor: theme.border }]}>
              <Text style={{ color: theme.muted, marginBottom: spacing.md }}>
                {index + 1 < chapters.length
                  ? `End of “${chapter?.title ?? ''}”`
                  : 'You finished the last chapter 🎉'}
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
          </>
        )}
      </ScrollView>

      {/* Bottom chapter bar */}
      <View style={[styles.bottomBar, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
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
        <View style={[styles.sheet, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
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
        <View style={[styles.sheet, styles.chapterSheet, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
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
        <View style={[styles.sheet, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>
            {noteMode === 'note' ? 'Add a note' : 'Save this passage'}
          </Text>
          <Text
            style={[styles.passagePreview, { color: theme.muted, borderColor: theme.border }]}
            numberOfLines={4}
          >
            {actionTarget?.text.slice(0, 260) ?? ''}
          </Text>
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
        <View style={[styles.sheet, styles.chapterSheet, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>Search this book</Text>
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
        </View>
      </Modal>

      {/* Notes & highlights drawer */}
      <Modal visible={notesOpen} transparent animationType="slide" onRequestClose={() => setNotesOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNotesOpen(false)} />
        <View style={[styles.sheet, styles.chapterSheet, { backgroundColor: theme.chrome, borderColor: theme.border }]}>
          <Text style={[styles.sheetTitle, { color: theme.text }]}>
            Notes & highlights{notes.length > 0 ? ` (${notes.length})` : ''}
          </Text>
          {notes.length === 0 ? (
            <Text style={{ color: theme.muted, paddingVertical: 12, lineHeight: 20 }}>
              Long-press any passage while reading to highlight it or attach a note.
            </Text>
          ) : (
            <ScrollView style={styles.flex} showsVerticalScrollIndicator={false}>
              {notes.map((entry) => (
                <View key={entry.id} style={[styles.noteRow, { borderColor: theme.border }]}>
                  <Pressable style={styles.flex} onPress={() => jumpToNote(entry)}>
                    <Text style={{ color: theme.muted, fontSize: 11, fontWeight: '700' }}>
                      Ch. {entry.chapter_number} · {entry.chapter_title}
                    </Text>
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
    paddingTop: Platform.select({ ios: 52, default: 34 }),
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
    paddingBottom: Platform.select({ ios: 26, default: 10 }),
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
    paddingBottom: Platform.select({ ios: 36, default: 22 }),
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
});
