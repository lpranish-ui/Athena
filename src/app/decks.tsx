// Review decks — every book with saved flashcards, with Anki-style due
// counts. Tap a deck to start a session.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { EmptyState, LoadingView } from '@/components/ui';
import { getDecks, type FlashcardDeck } from '@/lib/api';
import { colors, withAlpha } from '@/theme';

export default function DecksScreen() {
  const router = useRouter();
  const [decks, setDecks] = useState<FlashcardDeck[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setDecks(await getDecks());
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const totalDue = decks.reduce((sum, deck) => sum + deck.due, 0);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Review decks' }} />
      {loading ? (
        <LoadingView label="Loading decks…" />
      ) : decks.length === 0 ? (
        <EmptyState
          icon="albums-outline"
          title="No decks yet"
          message="Generate flashcards for any chapter (Study kit → Make flashcards), then tap “Save to review deck”. They will show up here scheduled for recall."
          actionLabel="Back"
          onAction={() => router.back()}
        />
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
          <Text style={styles.summary}>
            {totalDue > 0
              ? `${totalDue} card${totalDue === 1 ? '' : 's'} due across your decks`
              : 'All caught up — nothing due right now. You can still study ahead.'}
          </Text>
          {decks.map((deck) => (
            <Pressable
              key={deck.book_id}
              style={({ pressed }) => [styles.deckRow, pressed && styles.pressed]}
              onPress={() =>
                router.push({ pathname: '/deck/[bookId]', params: { bookId: deck.book_id } })
              }
            >
              <View style={styles.deckIcon}>
                <Ionicons name="albums-outline" size={20} color={colors.primary} />
              </View>
              <View style={styles.deckInfo}>
                <Text style={styles.deckTitle} numberOfLines={1}>
                  {deck.book_title}
                </Text>
                <Text style={styles.deckMeta}>
                  {deck.total} card{deck.total === 1 ? '' : 's'}
                  {deck.due > 0 ? ` · ${deck.due} due` : ' · up to date'}
                </Text>
              </View>
              {deck.due > 0 ? (
                <View style={styles.dueBadge}>
                  <Text style={styles.dueBadgeText}>{deck.due}</Text>
                </View>
              ) : (
                <Ionicons name="checkmark-circle-outline" size={18} color={colors.textMuted} />
              )}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: 32, gap: 10 },
  summary: { color: colors.textMuted, fontSize: 13, marginBottom: 6 },
  deckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pressed: { opacity: 0.75 },
  deckIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  deckInfo: { flex: 1, gap: 2 },
  deckTitle: { color: colors.text, fontWeight: '700', fontSize: 15 },
  deckMeta: { color: colors.textMuted, fontSize: 12 },
  dueBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  dueBadgeText: { color: colors.primaryText, fontSize: 12, fontWeight: '800' },
});
