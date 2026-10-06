// A live group-study room: lobby -> questions (timed, everyone together) ->
// reveal (correct answer, who was fastest, standings) -> final leaderboard.
//
// State is server-authoritative; this screen polls it and shows the right
// phase. The countdown uses a server-time offset so all phones agree.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { api, ApiError } from '@/lib/apiClient';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';

const LETTERS = 'ABCDEFGH';
const QUESTION_MS = 25_000;
const POLL_MS = 1500;

interface GroupPlayer {
  id: string;
  name: string;
  isHost: boolean;
  score: number;
  correctCount: number;
  totalMs: number;
  answeredCurrent: boolean;
}

interface GroupAnswer {
  playerId: string;
  optionIndex: number;
  correct: boolean;
  elapsedMs: number;
  points: number;
}

interface GroupState {
  room: {
    code: string;
    title: string | null;
    status: 'lobby' | 'playing' | 'finished';
    phase: 'lobby' | 'question' | 'reveal' | 'done';
    currentIndex: number;
    questionCount: number;
    questionEndsAt: string | null;
    revealEndsAt: string | null;
    serverNow: string;
    isHost: boolean;
  };
  players: GroupPlayer[];
  me: {
    id: string;
    score: number;
    correctCount: number;
    answeredCurrent: boolean;
    currentAnswer: { optionIndex: number; correct: boolean; elapsedMs: number; points: number } | null;
  } | null;
  question: { id: string; question: string; options: string[]; topic: string | null } | null;
  reveal: {
    id: string;
    question: string;
    options: string[];
    topic: string | null;
    correctIndex: number;
    explanation: string | null;
    optionExplanations: string[] | null;
    sourcePage: number | null;
    supportingQuote: string | null;
    fastestPlayerId: string | null;
    answers: GroupAnswer[];
  } | null;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function GroupRoomScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();

  const [state, setState] = useState<GroupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answerBusy, setAnswerBusy] = useState<number | null>(null);
  const [nextBusy, setNextBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // display clock (ticked every 400 ms while a question runs)
  const [nowMs, setNowMs] = useState(0);
  const [offsetMs, setOffsetMs] = useState(0);

  const applyState = useCallback((next: GroupState) => {
    setOffsetMs(Date.parse(next.room.serverNow) - Date.now());
    setNowMs(Date.now());
    setState(next);
  }, []);

  // Poll the room.
  useEffect(() => {
    if (!code) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await api.get<GroupState>(`/api/group/rooms/${code}`);
        if (!cancelled) {
          applyState(next);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          // Deep link / reopened app: join the room again, then keep polling.
          try {
            await api.post(`/api/group/rooms/${code}/join`, {});
          } catch (joinError) {
            if (!cancelled) {
              setError(joinError instanceof Error ? joinError.message : 'Could not join this game.');
            }
            // A finished/missing room will not recover through further polling.
            if (joinError instanceof ApiError && [403, 404, 409].includes(joinError.status)) return;
          }
        } else {
          setError(err instanceof Error ? err.message : 'Could not reach the game.');
        }
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [code, applyState]);

  const questionActive = state?.room.status === 'playing' && state.room.phase === 'question';

  // Tick the countdown clock only while a question is open.
  useEffect(() => {
    if (!questionActive) return;
    const timer = setInterval(() => setNowMs(Date.now()), 400);
    return () => clearInterval(timer);
  }, [questionActive]);

  const answer = async (optionIndex: number) => {
    if (!state || !code || !questionActive || state.me?.answeredCurrent) return;
    setAnswerBusy(optionIndex);
    try {
      const result = await api.post<{ correct: boolean; points: number; state: GroupState }>(
        `/api/group/rooms/${code}/answer`,
        { questionIndex: state.room.currentIndex, optionIndex },
      );
      applyState(result.state);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send your answer.');
    } finally {
      setAnswerBusy(null);
    }
  };

  const next = async () => {
    if (!code) return;
    setNextBusy(true);
    try {
      const result = await api.post<GroupState>(`/api/group/rooms/${code}/next`, {});
      applyState(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move on.');
    } finally {
      setNextBusy(false);
    }
  };

  const copyCode = async () => {
    const text = String(code ?? '');
    if (Platform.OS === 'web') {
      const clipboard = (
        globalThis as {
          navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
        }
      ).navigator?.clipboard;
      try {
        await clipboard?.writeText?.(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // ignore — the code is on screen anyway
      }
      return;
    }
    try {
      await Share.share({ message: `Join my Athena group quiz! Code: ${text}` });
    } catch {
      // cancelled
    }
  };

  if (!state) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Group game' }} />
        {error ? <ErrorBanner message={error} /> : <LoadingView label="Joining the room…" />}
      </Screen>
    );
  }

  const { room, players, me, question, reveal } = state;
  const playerName = (id: string) => players.find((player) => player.id === id)?.name ?? 'A player';

  // ── lobby ────────────────────────────────────────────────────────────────────
  if (room.status === 'lobby') {
    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: 'Group game' }} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Card style={styles.codeCard}>
            <Text style={styles.codeLabel}>Game code — share it with your friends</Text>
            <Text style={styles.code}>{room.code}</Text>
            <Button
              small
              variant="secondary"
              icon="copy-outline"
              label={copied ? 'Copied!' : 'Copy code'}
              onPress={() => void copyCode()}
            />
            <Text style={styles.codeHint}>
              Friends open Athena → Quizzes → Group study → Join game.
            </Text>
          </Card>

          <Card style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="people-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>
                Players ({players.length}) — {room.title ?? 'Group quiz'}
              </Text>
            </View>
            <View style={styles.playerWrap}>
              {players.map((player) => (
                <View key={player.id} style={styles.playerChip}>
                  {player.isHost ? (
                    <Ionicons name="star" size={13} color={colors.warning} />
                  ) : null}
                  <Text style={styles.playerName}>{player.name}</Text>
                </View>
              ))}
            </View>
            {error ? <ErrorBanner message={error} /> : null}
            {room.isHost ? (
              <>
                <Button
                  label={`Start — ${room.questionCount} questions`}
                  icon="play"
                  onPress={() => void nextStart()}
                  loading={nextBusy}
                />
                <Text style={styles.hint}>
                  25 seconds per question. Correct answers score 100 points + up to 50 speed bonus.
                </Text>
              </>
            ) : (
              <Text style={styles.waiting}>Waiting for the host to start…</Text>
            )}
          </Card>
        </ScrollView>
      </Screen>
    );
  }

  async function nextStart(): Promise<void> {
    if (!code) return;
    setNextBusy(true);
    try {
      const result = await api.post<GroupState>(`/api/group/rooms/${code}/start`, {});
      applyState(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the game.');
    } finally {
      setNextBusy(false);
    }
  }

  // ── finished ────────────────────────────────────────────────────────────────
  if (room.status === 'finished') {
    const ranked = [...players].sort((a, b) => b.score - a.score || a.totalMs - b.totalMs);
    const winner = ranked[0];
    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: 'Group game' }} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Card style={styles.winnerCard}>
            <Ionicons name="trophy" size={44} color={colors.warning} />
            <Text style={styles.winnerTitle}>{winner ? `${winner.name} wins!` : 'Game over'}</Text>
            {winner ? (
              <Text style={styles.winnerMeta}>
                {winner.score} points · {winner.correctCount} correct
              </Text>
            ) : null}
          </Card>

          <Card style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="podium-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Final leaderboard</Text>
            </View>
            <View style={styles.boardList}>
              {ranked.map((player, index) => (
                <View
                  key={player.id}
                  style={[styles.boardRow, player.id === me?.id && styles.boardRowMe]}
                >
                  <Text style={styles.boardRank}>{index + 1}</Text>
                  <View style={styles.boardInfo}>
                    <Text style={styles.boardName} numberOfLines={1}>
                      {player.name}
                      {player.id === me?.id ? ' (you)' : ''}
                    </Text>
                    <Text style={styles.boardMeta}>
                      {player.correctCount} correct · avg speed{' '}
                      {player.correctCount > 0
                        ? formatSeconds(player.totalMs / player.correctCount)
                        : '—'}
                    </Text>
                  </View>
                  <Text style={styles.boardPoints}>{player.score}</Text>
                </View>
              ))}
            </View>
          </Card>

          <Button label="Back to group study" onPress={() => router.replace('/group')} />
        </ScrollView>
      </Screen>
    );
  }

  // ── question + reveal ───────────────────────────────────────────────────────
  const shown = reveal ?? question;
  const endsAtMs = room.questionEndsAt ? Date.parse(room.questionEndsAt) : 0;
  const remainingMs = questionActive ? Math.max(0, endsAtMs - (nowMs + offsetMs)) : 0;
  const progress = questionActive ? Math.max(0, Math.min(1, remainingMs / QUESTION_MS)) : 0;
  const myAnswer = me?.currentAnswer ?? null;
  const fastest = reveal?.fastestPlayerId ?? null;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Group game' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.topRow}>
          <Text style={styles.questionCounter}>
            Question {room.currentIndex + 1} of {room.questionCount}
          </Text>
          <Text style={styles.myScore}>Your score: {me?.score ?? 0}</Text>
        </View>

        {questionActive ? (
          <View style={styles.timerTrack}>
            <View style={[styles.timerFill, { width: `${progress * 100}%` }]} />
            <Text style={styles.timerText}>{Math.ceil(remainingMs / 1000)}s</Text>
          </View>
        ) : null}

        {error ? <ErrorBanner message={error} /> : null}

        {shown?.topic ? <Badge label={shown.topic} color={colors.accent} /> : null}
        <Text style={styles.questionText}>{shown?.question}</Text>

        <View style={styles.options}>
          {shown?.options.map((option, optionIndex) => {
            const isCorrect = reveal ? optionIndex === reveal.correctIndex : false;
            const isMine = myAnswer?.optionIndex === optionIndex;
            const choosers = reveal
              ? reveal.answers
                  .filter((entry) => entry.optionIndex === optionIndex)
                  .map((entry) => playerName(entry.playerId))
              : [];

            return (
              <Pressable
                key={optionIndex}
                disabled={!questionActive || me?.answeredCurrent === true || answerBusy !== null}
                onPress={() => void answer(optionIndex)}
                style={({ pressed }) => [
                  styles.option,
                  isMine && !reveal && styles.optionMine,
                  reveal && isCorrect && styles.optionCorrect,
                  reveal && isMine && !isCorrect && styles.optionWrong,
                  pressed && questionActive && !me?.answeredCurrent && styles.optionPressed,
                ]}
              >
                <View
                  style={[
                    styles.letter,
                    reveal && isCorrect && styles.letterCorrect,
                    reveal && isMine && !isCorrect && styles.letterWrong,
                  ]}
                >
                  <Text
                    style={[
                      styles.letterText,
                      reveal && isCorrect && styles.letterTextCorrect,
                      reveal && isMine && !isCorrect && styles.letterTextWrong,
                    ]}
                  >
                    {LETTERS[optionIndex]}
                  </Text>
                </View>
                <View style={styles.optionBody}>
                  <Text style={styles.optionText}>{option}</Text>
                  {reveal && choosers.length > 0 ? (
                    <Text style={styles.choosers}>{choosers.join(', ')}</Text>
                  ) : null}
                </View>
                {reveal && fastest !== null && isCorrect && reveal.answers.some((a) => a.correct && a.elapsedMs === Math.min(...reveal.answers.filter((x) => x.correct).map((x) => x.elapsedMs))) ? (
                  <Ionicons name="flash" size={18} color={colors.warning} />
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {questionActive && me?.answeredCurrent && myAnswer ? (
          <Card style={styles.feedbackCard}>
            <Text style={myAnswer.correct ? styles.feedbackGood : styles.feedbackBad}>
              {myAnswer.correct
                ? `⚡ Locked in — correct! +${myAnswer.points} points (${formatSeconds(myAnswer.elapsedMs)})`
                : 'Locked in — waiting for the others to finish…'}
            </Text>
            <Text style={styles.hint}>
              {players.filter((player) => player.answeredCurrent).length} of {players.length}{' '}
              players have answered.
            </Text>
          </Card>
        ) : null}

        {questionActive && !me?.answeredCurrent ? (
          <View style={styles.playerWrap}>
            {players.map((player) => (
              <View key={player.id} style={styles.playerChip}>
                <Ionicons
                  name={player.answeredCurrent ? 'checkmark-circle' : 'ellipse-outline'}
                  size={13}
                  color={player.answeredCurrent ? colors.success : colors.textMuted}
                />
                <Text style={styles.playerName}>{player.name}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {reveal ? (
          <>
            {fastest ? (
              <Card style={styles.fastestCard}>
                <Ionicons name="flash" size={18} color={colors.warning} />
                <Text style={styles.fastestText}>
                  Fastest: {playerName(fastest)} —{' '}
                  {formatSeconds(reveal.answers.find((entry) => entry.playerId === fastest)?.elapsedMs ?? 0)}
                </Text>
              </Card>
            ) : (
              <Card style={styles.fastestCard}>
                <Text style={styles.fastestText}>Nobody got this one right! 😅</Text>
              </Card>
            )}

            {reveal.explanation ? (
              <Card style={styles.feedbackCard}>
                <Text style={styles.feedbackTitle}>Why</Text>
                <Text style={styles.explanationText}>{reveal.explanation}</Text>
                {reveal.optionExplanations
                  ? reveal.optionExplanations.map((entry, index) =>
                      entry ? (
                        <Text key={index} style={styles.optionExplanation}>
                          <Text style={styles.optionExplanationLetter}>{LETTERS[index]}</Text> {entry}
                        </Text>
                      ) : null,
                    )
                  : null}
                {reveal.supportingQuote ? (
                  <Text style={styles.quote}>“{reveal.supportingQuote}”</Text>
                ) : null}
              </Card>
            ) : null}

            <Card style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons name="podium-outline" size={18} color={colors.primary} />
                <Text style={styles.cardTitle}>Standings</Text>
              </View>
              <View style={styles.boardList}>
                {players.slice(0, 5).map((player, index) => (
                  <View key={player.id} style={styles.boardRow}>
                    <Text style={styles.boardRank}>{index + 1}</Text>
                    <Text style={styles.boardName} numberOfLines={1}>
                      {player.name}
                      {player.id === me?.id ? ' (you)' : ''}
                    </Text>
                    <Text style={styles.boardPoints}>{player.score}</Text>
                  </View>
                ))}
              </View>
              {room.isHost ? (
                <Button
                  label={
                    room.currentIndex + 1 >= room.questionCount
                      ? 'See final results'
                      : 'Next question'
                  }
                  icon="play-forward"
                  onPress={() => void next()}
                  loading={nextBusy}
                />
              ) : (
                <Text style={styles.waiting}>Next question coming up…</Text>
              )}
            </Card>
          </>
        ) : null}
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
  codeCard: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  codeLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  code: {
    color: colors.primary,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: 6,
  },
  codeHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textAlign: 'center',
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
    flex: 1,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  waiting: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  },
  playerWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  playerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  playerName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  questionCounter: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  myScore: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  timerTrack: {
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  timerFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: withAlpha(colors.primary, '44'),
  },
  timerText: {
    alignSelf: 'center',
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  questionText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    lineHeight: 24,
  },
  options: {
    gap: spacing.sm,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  optionPressed: {
    borderColor: colors.primary,
  },
  optionMine: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '14'),
  },
  optionCorrect: {
    borderColor: colors.success,
    backgroundColor: withAlpha(colors.success, '18'),
  },
  optionWrong: {
    borderColor: colors.danger,
    backgroundColor: withAlpha(colors.danger, '18'),
  },
  letter: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  letterCorrect: {
    backgroundColor: colors.success,
  },
  letterWrong: {
    backgroundColor: colors.danger,
  },
  letterText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  letterTextCorrect: {
    color: colors.primaryText,
  },
  letterTextWrong: {
    color: colors.primaryText,
  },
  optionBody: {
    flex: 1,
    gap: 2,
  },
  optionText: {
    color: colors.text,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  choosers: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  feedbackCard: {
    gap: spacing.sm,
  },
  feedbackGood: {
    color: colors.success,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  feedbackBad: {
    color: colors.warning,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  feedbackTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  explanationText: {
    color: colors.text,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  optionExplanation: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  optionExplanationLetter: {
    color: colors.accent,
    fontWeight: '800',
  },
  quote: {
    color: colors.accent,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  fastestCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  fastestText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  winnerCard: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  winnerTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
  },
  winnerMeta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  boardList: {
    gap: spacing.sm,
  },
  boardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  boardRowMe: {
    backgroundColor: withAlpha(colors.primary, '12'),
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  boardRank: {
    width: 22,
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
