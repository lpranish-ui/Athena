// Flashcard review — flip through a chapter's deck; export as CSV for Anki.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { LoadError } from '@/components/LoadError';
import { Button, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { saveFlashcards } from '@/lib/api';
import { api } from '@/lib/apiClient';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { Flashcard, StudyMaterial } from '@/types';

export default function FlashcardsScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const router = useRouter();

  const [cards, setCards] = useState<Flashcard[]>([]);
  const [chapterTitle, setChapterTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!chapterId) {
      setError('No chapter was selected.');
      setLoading(false);
      return;
    }

    try {
      const [materials, chapter] = await Promise.all([
        api.get<StudyMaterial[]>(`/api/study-materials?chapter_id=${chapterId}`),
        api.get<{ title: string }>(`/api/chapters/${chapterId}`),
      ]);

      const material = materials.find((entry) => entry.kind === 'flashcards') ?? null;
      setCards(material?.content.cards ?? []);
      setChapterTitle(chapter.title);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the flashcards.');
    }
    setLoading(false);
  }, [chapterId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const next = () => {
    setRevealed(false);
    setIndex((value) => (value + 1) % cards.length);
  };

  const previous = () => {
    setRevealed(false);
    setIndex((value) => (value - 1 + cards.length) % cards.length);
  };

  const saveToReview = async () => {
    if (!chapterId || cards.length === 0 || saving) return;
    setSaving(true);
    try {
      const result = await saveFlashcards(
        chapterId,
        cards.map((card) => ({ front: card.front, back: card.back, topic: card.topic })),
      );
      setSaveMessage(
        result.saved > 0
          ? `Saved ${result.saved} new card${result.saved === 1 ? '' : 's'} to your review deck — find them under Review decks in the library.`
          : 'All of these cards are already in your review deck.',
      );
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : 'Could not save the cards.');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = async () => {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = ['front,back', ...cards.map((card) => `${escape(card.front)},${escape(card.back)}`)].join(
      '\n',
    );

    if (Platform.OS === 'web') {
      const clipboard = (
        globalThis as {
          navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
        }
      ).navigator?.clipboard;
      if (clipboard?.writeText) {
        try {
          await clipboard.writeText(csv);
          setExportMessage(
            'CSV copied to your clipboard — in Anki: File → Import, paste, map front/back.',
          );
          return;
        } catch {
          // fall through to the message below
        }
      }
      setExportMessage('Clipboard access was blocked — try from the desktop app or localhost.');
      return;
    }

    try {
      await Share.share({ message: csv });
    } catch {
      setError('Sharing was cancelled.');
    }
  };

  if (loading) {
    return <LoadingView label="Loading flashcards…" />;
  }

  if (error && cards.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Flashcards' }} />
        <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} />
      </Screen>
    );
  }

  if (cards.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Flashcards' }} />
        <EmptyState
          icon="albums-outline"
          title="No flashcards yet"
          message="Open the chapter and tap “Make flashcards” in the Study kit card."
          actionLabel="Back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const card = cards[index];
  const deckProgress = ((index + 1) / cards.length) * 100;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Flashcards' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          <Text style={styles.context} numberOfLines={1}>
            {chapterTitle}
          </Text>
          <Text style={styles.count}>
            {index + 1} / {cards.length}
          </Text>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${deckProgress}%` }]} />
        </View>

        {error ? <ErrorBanner message={error} /> : null}

        <Pressable onPress={() => setRevealed((value) => !value)}>
          <View style={styles.deckCard}>
            {card.topic ? <Text style={styles.topic}>{card.topic}</Text> : null}
            <Text style={styles.front}>{card.front}</Text>

            {revealed ? (
              <>
                <View style={styles.separator} />
                <Text style={styles.back}>{card.back}</Text>
                {card.source_page ? (
                  <Text style={styles.page}>From page {card.source_page}</Text>
                ) : null}
              </>
            ) : (
              <View style={styles.tapHintRow}>
                <Ionicons name="eye-outline" size={16} color={colors.textMuted} />
                <Text style={styles.tapHint}>Tap to reveal</Text>
              </View>
            )}
          </View>
        </Pressable>

        <View style={styles.actions}>
          <Button small variant="secondary" label="Previous" onPress={previous} style={styles.actionButton} />
          <Button small label="Next" onPress={next} style={styles.actionButton} />
        </View>

        {exportMessage ? <Text style={styles.exportMessage}>{exportMessage}</Text> : null}

        {saveMessage ? <Text style={styles.exportMessage}>{saveMessage}</Text> : null}

        <Button
          label="Save to review deck"
          icon="sparkles-outline"
          loading={saving}
          onPress={() => void saveToReview()}
        />

        <Button
          variant="ghost"
          label="Export for Anki (CSV)"
          icon="download-outline"
          onPress={() => void exportCsv()}
        />
        <Text style={styles.footerHint}>
          Anki and other flashcard apps import the CSV as front/back cards.
        </Text>
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  context: {
    flex: 1,
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  count: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  deckCard: {
    minHeight: 260,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: withAlpha(colors.primary, '44'),
    borderRadius: radius.lg,
    padding: spacing.lg,
    justifyContent: 'center',
    gap: spacing.md,
  },
  topic: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  front: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
  },
  back: {
    color: '#CBD5E1',
    fontSize: 16,
    lineHeight: 24,
  },
  page: {
    color: colors.accent,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  tapHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tapHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    flex: 1,
  },
  exportMessage: {
    color: colors.success,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  footerHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textAlign: 'center',
  },
});
