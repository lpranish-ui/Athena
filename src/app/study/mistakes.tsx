import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Badge, Button, Card, EmptyState, LoadingView } from '@/components/ui';
import { SourceLinks, StudyPage, studyError, studyStyles } from '@/components/study/StudyUI';
import { getStudyDashboard } from '@/lib/study';
import { colors, withAlpha } from '@/theme';
import type { StudyDashboard } from '@/types/study';

type JournalFilter = 'open' | 'resolved' | 'all';

export default function StudyMistakesScreen() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<StudyDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<JournalFilter>('open');
  const request = useRef(0);

  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const data = await getStudyDashboard();
      if (version !== request.current) return;
      setDashboard(data);
      setError(null);
    } catch (err) {
      if (version === request.current) setError(studyError(err, 'Could not load your mistake journal.'));
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]));

  const mistakes = dashboard?.mistakes || [];
  const openCount = new Set(mistakes.filter((mistake) => !mistake.resolved).map((mistake) => mistake.concept_id)).size;
  const filtered = mistakes.filter((mistake) => filter === 'all' || (filter === 'resolved' ? mistake.resolved : !mistake.resolved));

  if (loading) return <LoadingView label="Opening your mistake journal…" />;

  return (
    <StudyPage>
      <Stack.Screen options={{ title: 'Mistake journal' }} />
      <View style={{ gap: 10 }}>
        <Text style={studyStyles.eyebrow}>MAKE EACH ATTEMPT USEFUL</Text>
        <Text style={studyStyles.title}>Your mistake journal</Text>
        <Text style={studyStyles.muted}>Notice the misunderstanding, revisit the explanation, then prove your recall in later practice.</Text>
      </View>
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {dashboard ? (
        <>
          <Card style={[studyStyles.card, styles.intro]}>
            <View style={studyStyles.row}>
              <Ionicons name="bulb-outline" size={25} color={colors.warning} />
              <View style={{ flex: 1, gap: 5 }}>
                <Text style={studyStyles.sectionTitle}>{openCount ? `${openCount} ${openCount === 1 ? 'concept' : 'concepts'} to revisit` : 'A place to build understanding'}</Text>
                <Text style={studyStyles.muted}>Unresolved mistakes help shape your daily session. Correct practice later marks them repaired.</Text>
              </View>
            </View>
            <Button label={dashboard.enrollment ? 'Open today’s study plan' : 'Set up a study plan'} icon="arrow-forward" onPress={() => router.replace('/today')} />
          </Card>
          <View style={styles.filters} accessibilityRole="radiogroup">
            {(['open', 'resolved', 'all'] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ checked: filter === value }}
                aria-checked={filter === value}
                onPress={() => setFilter(value)}
                style={[styles.filter, filter === value && styles.filterActive]}
              >
                <Text style={[styles.filterText, filter === value && { color: colors.primary }]}>{value === 'open' ? 'To repair' : value === 'resolved' ? 'Repaired' : 'All'}</Text>
              </Pressable>
            ))}
          </View>

          {filtered.map((mistake, index) => (
            <Card key={`${mistake.concept_id}-${mistake.created_at}-${index}`} style={studyStyles.card}>
              <View style={studyStyles.spread}>
                <Text style={[studyStyles.eyebrow, { flex: 1 }]}>{mistake.concept_title.toUpperCase()}</Text>
                <Badge label={mistake.resolved ? 'Repaired' : 'To repair'} color={mistake.resolved ? colors.success : colors.warning} />
              </View>
              <Text style={studyStyles.label}>{mistake.question}</Text>
              <View style={[styles.answer, styles.missedAnswer]}>
                <Text style={studyStyles.caption}>YOUR ANSWER</Text>
                <Text style={studyStyles.muted}>{mistake.selected_option}</Text>
              </View>
              <View style={[styles.answer, styles.correctAnswer]}>
                <Text style={[studyStyles.caption, { color: colors.success }]}>CORRECT ANSWER</Text>
                <Text style={studyStyles.body}>{mistake.correct_option}</Text>
              </View>
              {mistake.misconception ? (
                <View style={{ gap: 6 }}>
                  <Text style={studyStyles.label}>What to untangle</Text>
                  <Text style={studyStyles.muted}>{mistake.misconception}</Text>
                </View>
              ) : null}
              <View style={{ gap: 6 }}>
                <Text style={studyStyles.label}>Why this answer works</Text>
                <Text style={studyStyles.body}>{mistake.explanation}</Text>
              </View>
              <Text style={studyStyles.caption}>Confidence: {mistake.confidence === 'okay' ? 'Somewhat sure' : mistake.confidence === 'confident' ? 'Confident' : 'Unsure'} · {new Date(mistake.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text>
              <SourceLinks sources={mistake.sources} />
              <Pressable accessibilityRole="link" style={studyStyles.linkButton} onPress={() => router.push({ pathname: '/study/course', params: { conceptId: mistake.concept_id } })}>
                <Text style={studyStyles.link}>Read the concept lesson →</Text>
              </Pressable>
            </Card>
          ))}
          {filtered.length === 0 ? (
            <EmptyState
              icon={filter === 'resolved' ? 'checkmark-done-outline' : 'bookmarks-outline'}
              title={filter === 'resolved' ? 'No repaired mistakes yet' : mistakes.length ? 'Nothing waiting for repair' : 'Your journal starts with practice'}
              message={filter === 'resolved'
                ? 'Later correct practice will move a missed concept here.'
                : mistakes.length
                  ? 'You can revisit earlier mistakes under All. New practice will test what has stayed with you.'
                  : 'Complete a study session. Any missed answers will appear here with a targeted explanation and the original sources.'}
            />
          ) : null}
        </>
      ) : null}
    </StudyPage>
  );
}

const styles = StyleSheet.create({
  intro: { backgroundColor: '#17292E', borderColor: '#2A4448' },
  filters: { flexDirection: 'row', gap: 8 },
  filter: { flex: 1, minHeight: 46, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  filterActive: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '10') },
  filterText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  answer: { gap: 5, padding: 14, borderRadius: 12, borderWidth: 1 },
  missedAnswer: { backgroundColor: withAlpha(colors.danger, '07'), borderColor: withAlpha(colors.danger, '35') },
  correctAnswer: { backgroundColor: withAlpha(colors.success, '07'), borderColor: withAlpha(colors.success, '30') },
});
