// One-page high-yield chapter summary with page references.

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { LoadError } from '@/components/LoadError';
import { Button, Card, EmptyState, ErrorBanner, LoadingView } from '@/components/ui';
import { generateStudyKit } from '@/lib/api';
import { api } from '@/lib/apiClient';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { StudyMaterial } from '@/types';

export default function SummaryScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const router = useRouter();

  const [material, setMaterial] = useState<StudyMaterial | null>(null);
  const [chapterTitle, setChapterTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      setMaterial(materials.find((entry) => entry.kind === 'summary') ?? null);
      setChapterTitle(chapter.title);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the summary.');
    }
    setLoading(false);
  }, [chapterId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const regenerate = async () => {
    if (!chapterId) return;
    setRegenerating(true);
    setStage(null);
    setError(null);
    try {
      await generateStudyKit({ chapterId, kind: 'summary', onStage: setStage });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the summary.');
    } finally {
      setRegenerating(false);
      setStage(null);
    }
  };

  if (loading) {
    return <LoadingView label="Loading summary…" />;
  }

  if (error && !material?.content.overview) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Chapter summary' }} />
        <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} />
      </Screen>
    );
  }

  if (!material?.content.overview) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Chapter summary' }} />
        <EmptyState
          icon="reader-outline"
          title="No summary yet"
          message="Open the chapter and tap “Make summary” in the Study kit card."
          actionLabel="Back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const { overview, points } = material.content;

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: 'Chapter summary' }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.context}>{chapterTitle}</Text>

        {error ? <ErrorBanner message={error} /> : null}

        <Card style={styles.overviewCard}>
          <View style={styles.overviewHeader}>
            <Ionicons name="flash-outline" size={18} color={colors.primary} />
            <Text style={styles.overviewTitle}>At a glance</Text>
          </View>
          <Text style={styles.overviewText}>{overview}</Text>
        </Card>

        <Text style={styles.sectionTitle}>High-yield points</Text>

        {(points ?? []).map((point, index) => (
          <Card key={index} style={styles.pointCard}>
            <View style={styles.pointHeader}>
              <Text style={styles.pointNumber}>{index + 1}</Text>
              <Text style={styles.pointHeading}>{point.heading}</Text>
              {point.page ? (
                <View style={styles.pageChip}>
                  <Text style={styles.pageChipText}>p. {point.page}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.pointDetail}>{point.detail}</Text>
          </Card>
        ))}

        <Button
          variant="secondary"
          label="Regenerate summary"
          icon="refresh-outline"
          onPress={() => void regenerate()}
          loading={regenerating}
        />
        {regenerating && stage ? <Text style={styles.footerHint}>{stage}</Text> : null}
        <Text style={styles.footerHint}>
          Summaries are written only from this chapter’s text; verify anything critical in the book
          itself.
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
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  },
  context: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  overviewCard: {
    gap: spacing.sm,
    borderColor: withAlpha(colors.primary, '44'),
  },
  overviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  overviewTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
  overviewText: {
    color: '#CBD5E1',
    fontSize: 15,
    lineHeight: 24,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  pointCard: {
    gap: spacing.sm,
  },
  pointHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pointNumber: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '800',
    width: 18,
  },
  pointHeading: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  pageChip: {
    backgroundColor: withAlpha(colors.accent, '1F'),
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pageChipText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '800',
  },
  pointDetail: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: 21,
    paddingLeft: 26,
  },
  footerHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textAlign: 'center',
  },
});
