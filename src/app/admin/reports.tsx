import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { StudyPage, studyStyles } from '@/components/study/StudyUI';
import { Badge, Button, Card, LoadingView } from '@/components/ui';
import { api } from '@/lib/apiClient';
import { colors } from '@/theme';

interface AdminReport {
  id: string;
  course_id: string;
  pack_version: string;
  concept_id: string;
  question_id: string | null;
  category: string;
  message: string;
  status: 'open' | 'triaged' | 'resolved';
  created_at: string;
  updated_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  accuracy: 'Medical accuracy',
  source: 'Source or citation',
  unclear: 'Unclear explanation',
  other: 'Other issue',
};

const STATUS_COLORS: Record<AdminReport['status'], string> = {
  open: colors.warning,
  triaged: colors.primary,
  resolved: colors.success,
};

/** Operator-only queue; the API 403s (or 404s while disabled) for everyone else. */
export default function AdminReportsScreen() {
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get<{ reports: AdminReport[] }>('/api/admin/reports');
      setReports(response.reports);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load reports.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const triage = async (id: string, status: AdminReport['status']) => {
    setBusyId(id);
    try {
      await api.patch(`/api/admin/reports/${id}`, { status });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the report.');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <LoadingView label="Loading reports…" />;

  return (
    <StudyPage>
      <Text style={studyStyles.title}>Content reports</Text>
      <Text style={studyStyles.muted}>
        Triage student reports about course objectives and graded questions. Resolve only after the
        content is corrected; reporter identities are not shown.
      </Text>

      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {!error && reports.length === 0 ? (
        <Text style={studyStyles.muted}>Nothing in the queue right now.</Text>
      ) : null}

      {reports.map((report) => (
        <Card key={report.id} style={studyStyles.card}>
          <View style={studyStyles.spread}>
            <Text style={studyStyles.label}>
              {CATEGORY_LABELS[report.category] ?? report.category}
            </Text>
            <Badge label={report.status} color={STATUS_COLORS[report.status]} />
          </View>
          <Text style={studyStyles.muted}>{report.message}</Text>
          <Text style={studyStyles.caption}>
            {report.course_id} · {report.concept_id.replaceAll('-', ' ')}
            {report.question_id ? ` · question ${report.question_id}` : ''}
          </Text>
          <Text style={studyStyles.caption}>
            {report.pack_version} · reported {new Date(report.created_at).toLocaleDateString()}
          </Text>
          <View style={styles.actions}>
            {report.status !== 'triaged' ? (
              <Button
                small
                variant="secondary"
                label="Triaged"
                loading={busyId === report.id}
                onPress={() => void triage(report.id, 'triaged')}
              />
            ) : null}
            {report.status !== 'resolved' ? (
              <Button
                small
                label="Resolved"
                loading={busyId === report.id}
                onPress={() => void triage(report.id, 'resolved')}
              />
            ) : (
              <Button
                small
                variant="secondary"
                label="Reopen"
                loading={busyId === report.id}
                onPress={() => void triage(report.id, 'open')}
              />
            )}
          </View>
        </Card>
      ))}

      <Button variant="secondary" label="Back to Today" onPress={() => router.replace('/today')} />
    </StudyPage>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
});
