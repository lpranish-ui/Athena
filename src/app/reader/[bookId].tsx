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
    Modal,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import { LoadingView } from '@/components/ui';
import { getReadingProgress, saveReadingProgress } from '@/lib/api';
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

  const scrollRef = useRef<ScrollView>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const contentHeightRef = useRef(0);
  const layoutHeightRef = useRef(0);
  const ratioRef = useRef(0);
  const chapterIdRef = useRef<string | null>(null);
  const lastSaveRef = useRef(0);
  const suppressScrollRef = useRef(false);
  const restoreUntilRef = useRef(0);

  const theme = READER_THEMES[settings.theme];

  // ── initial load: book, chapters, saved position, settings ────────────────

  useEffect(() => {
    if (!bookId) return;
    void (async () => {
      try {
        const [bookData, chaptersData, progress, settingsRaw] = await Promise.all([
          api.get<Book>(`/api/books/${bookId}`),
          api.get<ChapterSummary[]>(`/api/books/${bookId}/chapters`),
          getReadingProgress(bookId),
          AsyncStorage.getItem(SETTINGS_KEY),
        ]);

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
    if (!summary) {
      if (!loading && chapters.length === 0) setError('This book has no chapters yet.');
      return;
    }
    let cancelled = false;
    setLoadingChapter(true);
    void (async () => {
      try {
        const data = await api.get<ChapterContent & { content: string }>(
          `/api/chapters/${summary.id}`,
        );
        if (cancelled) return;
        setChapter({
          id: data.id,
          title: data.title,
          content: data.content,
          number: data.number,
        });
        chapterIdRef.current = data.id;
        setLoading(false);
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
  }, [chapters, index, loading]);

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
    pendingScrollRef.current = null;
    restoreUntilRef.current = 0;

    const max = Math.max(1, contentSize.height - layoutMeasurement.height);
    ratioRef.current = Math.min(1, Math.max(0, contentOffset.y / max));

    const now = Date.now();
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
    if (restoreUntilRef.current === 0) restoreUntilRef.current = Date.now() + 1500;

    const max = Math.max(0, contentHeightRef.current - layoutHeightRef.current);
    suppressScrollRef.current = true;
    scrollRef.current?.scrollTo({ y: pending * max, animated: false });

    if (Date.now() >= restoreUntilRef.current) {
      pendingScrollRef.current = null;
      restoreUntilRef.current = 0;
    }
  };

  const handleContentSize = (_width: number, height: number) => {
    contentHeightRef.current = height;
    applyPendingScroll();
  };

  const jumpToChapter = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= chapters.length) return;
    flushProgress();
    ratioRef.current = 0;
    pendingScrollRef.current = 0;
    restoreUntilRef.current = 0;
    setChaptersOpen(false);
    setIndex(nextIndex);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
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
            {paragraphs.map((paragraph, paragraphIndex) => (
              <Text
                key={paragraphIndex}
                selectable
                style={{
                  color: theme.text,
                  fontFamily: serifFamily,
                  fontSize: settings.fontSize,
                  lineHeight,
                  marginBottom: Math.round(lineHeight * 0.55),
                }}
              >
                {paragraph}
              </Text>
            ))}

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
});
