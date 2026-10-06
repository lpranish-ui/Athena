// Review decks — every book with saved flashcards, with Anki-style due
// counts. Tap a deck to start a session.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { EmptyState, LoadingView } from '@/components/ui';
import { getDecks, type FlashcardDeck } from '@/lib/api';
import {
  getReminderEnabled,
  remindersSupported,
  scheduleDailyReviewReminder,
  setReminderEnabled,
} from '@/lib/reminders';
import { colors, withAlpha } from '@/theme';

export default function DecksScreen() {
  const router = useRouter();
  const [decks, setDecks] = useState<FlashcardDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [reminderOn, setReminderOn] = useState(false);
  const [reminderError, setReminderError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDecks(await getDecks());
    setReminderOn(await getReminderEnabled());
    setLoading(false);
    // Keep the daily reminder in sync with the saved preference.
    void scheduleDailyReviewReminder();
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const totalDue = decks.reduce((sum, deck) => sum + deck.due, 0);

  const toggleReminder = async () => {
    const next = !reminderOn;
    const ok = await setReminderEnabled(next);
    if (next && !ok) {
      setReminderOn(false);
      setReminderError('Notification permission was declined — allow notifications for Athena.');
      return;
    }
    setReminderError(null);
    setReminderOn(ok);
  };

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
          {remindersSupported ? (
            <View style={styles.reminderRow}>
              <Ionicons name="notifications-outline" size={18} color={colors.accent} />
              <View style={styles.reminderInfo}>
                <Text style={styles.reminderTitle}>Daily review reminder</Text>
                <Text style={styles.reminderMeta}>
                  {reminderOn
                    ? 'On — a reminder fires at 8:00 pm every day.'
                    : 'Get a nudge at 8:00 pm when cards are waiting.'}
                </Text>
                {reminderError ? <Text style={styles.reminderError}>{reminderError}</Text> : null}
              </View>
              <Switch
                value={reminderOn}
                onValueChange={() => void toggleReminder()}
                trackColor={{ false: colors.border, true: withAlpha(colors.primary, '99') }}
                thumbColor={reminderOn ? colors.primary : colors.textMuted}
              />
            </View>
          ) : null}
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
  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
  },
  reminderInfo: { flex: 1, gap: 2 },
  reminderTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
  reminderMeta: { color: colors.textMuted, fontSize: 12 },
  reminderError: { color: colors.warning, fontSize: 12, marginTop: 2 },
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
