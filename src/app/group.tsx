// Group study — play live quizzes with friends.
//
// Create a room (picks one of your quizzes) and share the 6-letter code, or
// join a friend's room with their code. Same questions for everyone, points
// for correct answers with a speed bonus, live standings and a global
// leaderboard.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, Input, LoadingView } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { Difficulty, McqSetWithContext, Profile } from '@/types';

const DIFFICULTY_COLORS: Record<Difficulty, string> = {
  easy: colors.success,
  medium: colors.warning,
  hard: colors.danger,
};

interface LeaderboardRow {
  user_id: string;
  name: string;
  points: number;
  games: number;
  wins: number;
}

/** Quiz sets as returned by GET /api/sets (includes the question count). */
type PlayableSet = McqSetWithContext & { question_count?: number };

export default function GroupHomeScreen() {
  const router = useRouter();

  const [sets, setSets] = useState<PlayableSet[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState('');
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [setsData, profile, board] = await Promise.all([
        api.get<PlayableSet[]>('/api/sets'),
        api.get<Profile | null>('/api/profile'),
        api.get<LeaderboardRow[]>('/api/group/leaderboard'),
      ]);

      const playable = setsData.filter((set) => (set.question_count ?? 0) >= 3);
      setSets(playable);
      setSelectedSetId((previous) =>
        previous && playable.some((set) => set.id === previous) ? previous : (playable[0]?.id ?? null),
      );
      setName((previous) => previous || (profile?.full_name ?? ''));
      setLeaderboard(board);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load group study.');
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const create = async () => {
    if (!selectedSetId) {
      setError('Pick a quiz to play with your friends.');
      return;
    }
    setBusy('create');
    setError(null);
    try {
      const created = await api.post<{ code: string }>('/api/group/rooms', {
        setId: selectedSetId,
        name: name.trim() || undefined,
      });
      router.push({ pathname: '/group/[code]', params: { code: created.code } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the room.');
    } finally {
      setBusy(null);
    }
  };

  const join = async () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) {
      setError('Enter the 6-letter game code.');
      return;
    }
    setBusy('join');
    setError(null);
    try {
      await api.post(`/api/group/rooms/${code}/join`, { name: name.trim() || undefined });
      router.push({ pathname: '/group/[code]', params: { code } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join that game.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <LoadingView label="Opening group study…" />;
  }

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Group study' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          Quiz your friends live: everyone gets the same question at the same time. Points go to
          correct answers — the faster you are, the more you score.
        </Text>

        {error ? <ErrorBanner message={error} /> : null}

        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="person-add-outline" size={18} color={colors.primary} />
            <Text style={styles.cardTitle}>Your name in the game</Text>
          </View>
          <Input
            value={name}
            onChangeText={setName}
            placeholder="e.g. Dr. Ranish"
            maxLength={30}
          />
        </Card>

        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
            <Text style={styles.cardTitle}>Host a game</Text>
          </View>
          {sets.length === 0 ? (
            <Text style={styles.hint}>
              You need a quiz with at least 3 questions first — generate one from any chapter, then
              come back.
            </Text>
          ) : (
            <View style={styles.setList}>
              {sets.map((set) => {
                const active = set.id === selectedSetId;
                return (
                  <Pressable
                    key={set.id}
                    onPress={() => setSelectedSetId(set.id)}
                    style={[styles.setRow, active && styles.setRowActive]}
                  >
                    <View style={styles.setInfo}>
                      <Text style={styles.setTitle} numberOfLines={1}>
                        {set.title ?? 'Quiz'}
                      </Text>
                      <Text style={styles.setMeta}>
                        {set.question_count ?? 0} questions
                        {set.chapter?.book?.title ? ` · ${set.chapter.book.title}` : ''}
                      </Text>
                    </View>
                    <Badge
                      label={set.difficulty.charAt(0).toUpperCase() + set.difficulty.slice(1)}
                      color={DIFFICULTY_COLORS[set.difficulty]}
                    />
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={18}
                      color={active ? colors.primary : colors.textMuted}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
          <Button
            label="Create room & get a code"
            icon="people-outline"
            onPress={() => void create()}
            loading={busy === 'create'}
            disabled={sets.length === 0}
          />
        </Card>

        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="enter-outline" size={18} color={colors.accent} />
            <Text style={styles.cardTitle}>Join a friend’s game</Text>
          </View>
          <Input
            value={joinCode}
            onChangeText={(text) => setJoinCode(text.toUpperCase())}
            placeholder="6-letter code (e.g. K7PM2Q)"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={6}
          />
          <Button
            label="Join game"
            variant="secondary"
            icon="log-in-outline"
            onPress={() => void join()}
            loading={busy === 'join'}
          />
        </Card>

        <Card style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="trophy-outline" size={18} color={colors.warning} />
            <Text style={styles.cardTitle}>Leaderboard</Text>
          </View>
          {leaderboard.length === 0 ? (
            <Text style={styles.hint}>
              No finished games yet — win the first one and your name goes here!
            </Text>
          ) : (
            <View style={styles.boardList}>
              {leaderboard.slice(0, 10).map((row, index) => (
                <View key={row.user_id} style={styles.boardRow}>
                  <Text style={styles.boardRank}>{index + 1}</Text>
                  <View style={styles.boardInfo}>
                    <Text style={styles.boardName} numberOfLines={1}>
                      {row.name}
                    </Text>
                    <Text style={styles.boardMeta}>
                      {row.games} game{row.games === 1 ? '' : 's'} · {row.wins} win
                      {row.wins === 1 ? '' : 's'}
                    </Text>
                  </View>
                  <Text style={styles.boardPoints}>{row.points}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>
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
  card: {
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  setList: {
    gap: spacing.sm,
  },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  setRowActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '14'),
  },
  setInfo: {
    flex: 1,
    gap: 2,
  },
  setTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  setMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  boardList: {
    gap: spacing.sm,
  },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  boardRank: {
    width: 24,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  boardInfo: {
    flex: 1,
    gap: 1,
  },
  boardName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  boardMeta: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  boardPoints: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
});
