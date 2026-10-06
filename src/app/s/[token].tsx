// Public share page — opens without an account and renders a read-only
// snapshot created by another user: quiz answers, a review deck, or a
// single highlight/note.
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, ErrorBanner, LoadingView } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { colors, withAlpha } from '@/theme';

interface SharedQuestion {
  question: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  question_type: string;
  supporting_quote: string | null;
  topic: string | null;
}

interface SharedCard {
  front: string;
  back: string;
  topic: string | null;
}

interface SetPayload {
  title: string | null;
  book_title: string | null;
  difficulty: string | null;
  questions: SharedQuestion[];
}

interface DeckPayload {
  book_title: string | null;
  cards: SharedCard[];
}

interface NotePayload {
  kind: 'highlight' | 'note';
  text: string;
  color: string | null;
  paragraph_index: number;
  chapter_title: string;
  book_title: string;
  created_at: string;
}

interface ShareResponse {
  kind: 'set' | 'deck' | 'note';
  payload: SetPayload | DeckPayload | NotePayload;
  created_at: string;
}

const COLOR_DOTS: Record<string, string> = {
  gold: '#D2921F',
  blue: '#6D8BFF',
  green: '#34D399',
  pink: '#F472B6',
};

export default function SharedContentScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const router = useRouter();
  const [data, setData] = useState<ShareResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealedCards, setRevealedCards] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        setData(await api.get<ShareResponse>(`/api/shares/${token}`));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This link could not be opened.');
      }
    })();
  }, [token]);

  const toggleCard = (index: number) => {
    setRevealedCards((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  if (error) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Shared with you' }} />
        <ErrorBanner message={error} />
        <Button label="Open Athena" icon="home-outline" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  if (!data) {
    return <LoadingView label="Opening shared content…" />;
  }

  if (data.kind === 'set') {
    const payload = data.payload as SetPayload;
    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: payload.title ?? 'Shared quiz' }} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>{payload.title ?? 'Shared quiz'}</Text>
          <Text style={styles.subtitle}>
            {payload.book_title ?? 'Athena'}{' '}
            {payload.difficulty ? `· ${payload.difficulty} · ` : '· '}
            {payload.questions.length} question{payload.questions.length === 1 ? '' : 's'} · answers
            included
          </Text>
          {payload.questions.map((question, questionIndex) => (
            <View key={questionIndex} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.questionNumber}>Question {questionIndex + 1}</Text>
                {question.topic ? <Text style={styles.topic}>{question.topic}</Text> : null}
              </View>
              <Text style={styles.questionText}>{question.question}</Text>
              {(question.options ?? []).map((option, optionIndex) => {
                const isCorrect = optionIndex === question.correct_index;
                return (
                  <View
                    key={optionIndex}
                    style={[styles.option, isCorrect && styles.optionCorrect]}
                  >
                    <Text style={[styles.optionText, isCorrect && styles.optionTextCorrect]}>
                      {isCorrect ? '✓ ' : ''}
                      {option}
                    </Text>
                  </View>
                );
              })}
              {question.explanation ? (
                <Text style={styles.explanation}>{question.explanation}</Text>
              ) : null}
              {question.supporting_quote ? (
                <Text style={styles.quote}>“{question.supporting_quote}”</Text>
              ) : null}
            </View>
          ))}
          <Button label="Open Athena" icon="home-outline" onPress={() => router.replace('/')} />
        </ScrollView>
      </Screen>
    );
  }

  if (data.kind === 'deck') {
    const payload = data.payload as DeckPayload;
    return (
      <Screen padded={false} edges={['left', 'right']}>
        <Stack.Screen options={{ title: 'Shared deck' }} />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.title}>{payload.book_title ?? 'Shared deck'}</Text>
          <Text style={styles.subtitle}>
            {payload.cards.length} flashcard{payload.cards.length === 1 ? '' : 's'} · tap a card to
            flip it
          </Text>
          {payload.cards.map((card, cardIndex) => {
            const revealed = revealedCards.has(cardIndex);
            return (
              <Pressable
                key={cardIndex}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}
                onPress={() => toggleCard(cardIndex)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.questionNumber}>Card {cardIndex + 1}</Text>
                  {card.topic ? <Text style={styles.topic}>{card.topic}</Text> : null}
                </View>
                <Text style={styles.questionText}>{card.front}</Text>
                {revealed ? (
                  <Text style={styles.answerText}>{card.back}</Text>
                ) : (
                  <Text style={styles.revealHint}>Tap to reveal the answer</Text>
                )}
              </Pressable>
            );
          })}
          <Button label="Open Athena" icon="home-outline" onPress={() => router.replace('/')} />
        </ScrollView>
      </Screen>
    );
  }

  const payload = data.payload as NotePayload;
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Shared highlight' }} />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View
            style={[
              styles.colorDot,
              { backgroundColor: COLOR_DOTS[payload.color ?? 'gold'] ?? COLOR_DOTS.gold },
            ]}
          />
          <Text style={styles.topic}>
            {payload.kind === 'note' ? 'Note' : 'Highlight'} · {payload.chapter_title}
          </Text>
        </View>
        <Text style={styles.quoteBlock}>“{payload.text}”</Text>
        <Text style={styles.subtitle}>{payload.book_title}</Text>
      </View>
      <Button label="Open Athena" icon="home-outline" onPress={() => router.replace('/')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40, gap: 12 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginBottom: 4 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  questionNumber: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  topic: { color: colors.textMuted, fontSize: 12 },
  questionText: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  optionCorrect: {
    borderColor: colors.success,
    backgroundColor: withAlpha(colors.success, '1A'),
  },
  optionText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  optionTextCorrect: { color: colors.success, fontWeight: '700' },
  explanation: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  quote: { color: colors.textMuted, fontSize: 13, fontStyle: 'italic' },
  answerText: { color: colors.success, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  revealHint: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic' },
  quoteBlock: { color: colors.text, fontSize: 16, lineHeight: 24, fontStyle: 'italic' },
  colorDot: { width: 10, height: 10, borderRadius: 5 },
  pressed: { opacity: 0.75 },
});
