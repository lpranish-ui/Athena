// One review session: show the card, reveal, grade with Again/Hard/Good/Easy.
// Same scheduling ideas as the old system, but four grades and a deck that
// mixes as many chapters of a book as you saved cards from.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { gradeCard, getDeckCards, type DeckCard } from '@/lib/api';
import { gradePreview, isDue, scheduleCard, type FlashcardGrade } from '@/lib/review';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';

const GRADES: { grade: FlashcardGrade; label: string; key: string; color: string }[] = [
  { grade: 'again', label: 'Again', key: '1', color: '#E5484D' },
  { grade: 'hard', label: 'Hard', key: '2', color: '#D2921F' },
  { grade: 'good', label: 'Good', key: '3', color: '#34C77B' },
  { grade: 'easy', label: 'Easy', key: '4', color: '#6D8BFF' },
];

export default function DeckSessionScreen() {
  const { bookId } = useLocalSearchParams<{ bookId: string }>();
  const router = useRouter();

  const [cards, setCards] = useState<DeckCard[]>([]);
  const [bookTitle, setBookTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<DeckCard[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [reviewed, setReviewed] = useState(0);

  const load = useCallback(async () => {
    if (!bookId) return;
    try {
      const [deck, book] = await Promise.all([
        getDeckCards(bookId),
        api.get<{ title: string }>(`/api/books/${bookId}`),
      ]);
      setCards(deck);
      setBookTitle(book.title);
      const due = deck.filter((card) => isDue(card.due_at));
      setQueue(due.length > 0 ? due : deck);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the deck.');
    }
    setLoading(false);
  }, [bookId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const current = queue[0] ?? null;
  const done = !loading && cards.length > 0 && current === null;

  const applyGrade = (grade: FlashcardGrade) => {
    if (!current) return;
    const schedule = scheduleCard(
      {
        stability: current.stability,
        difficulty: current.difficulty,
        reps: current.reps,
        lapses: current.lapses,
      },
      grade,
    );
    setReviewed((count) => count + 1);
    setRevealed(false);
    setQueue((previous) => {
      const rest = previous.slice(1);
      const updated: DeckCard = { ...current, ...schedule };
      return grade === 'again' ? [...rest, updated] : rest;
    });
    void gradeCard(current.id, {
      stability: schedule.stability,
      difficulty: schedule.difficulty,
      reps: schedule.reps,
      lapses: schedule.lapses,
      due_at: schedule.due_at,
      last_reviewed_at: schedule.last_reviewed_at,
    }).catch(() => {});
  };

  // Web: Space/Enter reveals, 1-4 grade (kept in a ref so the listener sees
  // the latest state without re-registering every render).
  const handlerRef = useRef<(event: { key: string; preventDefault: () => void }) => void>(() => {});
  useEffect(() => {
    handlerRef.current = (event) => {
      if (!current) return;
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed && ['1', '2', '3', '4'].includes(event.key)) {
        const picked = GRADES.find((entry) => entry.key === event.key);
        if (picked) applyGrade(picked.grade);
      }
    };
  });

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    type Listener = (event: { key: string; preventDefault: () => void }) => void;
    const win = globalThis as unknown as {
      addEventListener?: (type: string, listener: Listener) => void;
      removeEventListener?: (type: string, listener: Listener) => void;
    };
    const add = win.addEventListener;
    const remove = win.removeEventListener;
    if (!add || !remove) return;
    const listener: Listener = (event) => handlerRef.current(event);
    add('keydown', listener);
    return () => remove('keydown', listener);
  }, []);

  if (loading) {
    return <LoadingView label="Loading your deck…" />;
  }

  if (error) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Deck' }} />
        <ErrorBanner message={error} />
      </Screen>
    );
  }

  if (cards.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Deck' }} />
        <EmptyState
          icon="albums-outline"
          title="No cards in this deck"
          message="Open a chapter, generate flashcards in the Study kit, and tap “Save to review deck”."
          actionLabel="Back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Deck' }} />
        <View style={styles.doneBox}>
          <Ionicons name="checkmark-circle" size={54} color="#34C77B" />
          <Text style={styles.doneTitle}>Session complete</Text>
          <Text style={styles.doneText}>
            You reviewed {reviewed} card{reviewed === 1 ? '' : 's'} from {bookTitle}. Come back when
            more cards are due — the schedule spaces them out for you.
          </Text>
          <Button label="Back to decks" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  if (!current) return null;

  const state = {
    stability: current.stability,
    difficulty: current.difficulty,
    reps: current.reps,
    lapses: current.lapses,
  };

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: bookTitle || 'Deck' }} />
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Text style={styles.context} numberOfLines={1}>
            {current.topic ?? 'Review'}
          </Text>
          <Text style={styles.count}>
            {reviewed} done · {queue.length} left
          </Text>
        </View>

        <Pressable onPress={() => setRevealed(true)} style={styles.cardBox}>
          <Text style={styles.front}>{current.front}</Text>
          {revealed ? (
            <>
              <View style={styles.separator} />
              <Text style={styles.back}>{current.back}</Text>
            </>
          ) : (
            <View style={styles.tapHintRow}>
              <Ionicons name="eye-outline" size={16} color={colors.textMuted} />
              <Text style={styles.tapHint}>Tap to reveal</Text>
            </View>
          )}
        </Pressable>

        {revealed ? (
          <View style={styles.gradeRow}>
            {GRADES.map((entry) => (
              <Pressable
                key={entry.grade}
                onPress={() => applyGrade(entry.grade)}
                style={[styles.gradeButton, { borderColor: entry.color }]}
              >
                <Text style={[styles.gradeLabel, { color: entry.color }]}>{entry.label}</Text>
                <Text style={styles.gradeHint}>
                  {gradePreview(state, entry.grade)}
                  {Platform.OS === 'web' ? ` · ${entry.key}` : ''}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <Text style={styles.footerHint}>
            {Platform.OS === 'web'
              ? 'Space or Enter reveals the answer — then 1-4 to grade.'
              : 'Recall the answer in your head first, then tap to check.'}
          </Text>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 20,
    paddingBottom: 40,
    gap: spacing.md,
    maxWidth: 640,
    width: '100%',
    alignSelf: 'center',
    flex: 1,
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
  count: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700' },
  cardBox: {
    minHeight: 280,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: withAlpha(colors.primary, '44'),
    borderRadius: radius.lg,
    padding: spacing.lg,
    justifyContent: 'center',
    gap: spacing.md,
  },
  front: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700', lineHeight: 28 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  back: { color: colors.text, fontSize: fontSize.md, lineHeight: 24 },
  tapHintRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tapHint: { color: colors.textMuted, fontSize: fontSize.sm },
  footerHint: { color: colors.textMuted, fontSize: fontSize.xs, textAlign: 'center' },
  gradeRow: { flexDirection: 'row', gap: 8 },
  gradeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    gap: 2,
  },
  gradeLabel: { fontWeight: '800', fontSize: fontSize.sm },
  gradeHint: { color: colors.textMuted, fontSize: 11 },
  doneBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: 24 },
  doneTitle: { color: colors.text, fontSize: fontSize.xl, fontWeight: '800' },
  doneText: { color: colors.textMuted, textAlign: 'center', lineHeight: 21, marginBottom: 8 },
});
