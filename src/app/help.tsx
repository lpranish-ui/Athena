import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { Badge, Button, Card, LoadingView } from '@/components/ui';
import { LoadError } from '@/components/LoadError';
import { StudyPage, studyStyles } from '@/components/study/StudyUI';
import { api } from '@/lib/apiClient';

interface Report { id: string; course_id: string; concept_id: string; category: string; status: string; created_at: string }
export default function HelpScreen() {
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOperator, setIsOperator] = useState(false);
  const load = useCallback(async () => {
    try { setReports(await api.get<Report[]>('/api/study/reports')); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load reports.'); }
    // Operator tooling stays invisible unless this account is listed in ADMIN_EMAILS.
    try { await api.get('/api/admin/reports?status=open'); setIsOperator(true); }
    catch { setIsOperator(false); }
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  return <StudyPage>
    <Text style={studyStyles.title}>Help & feedback</Text>
    <Card style={studyStyles.card}>
      <Text style={studyStyles.sectionTitle}>Start with a short session</Text>
      <Text style={studyStyles.muted}>Choose a study track, set your daily time, and open Today. Lessons introduce a concept; practice explains your answer and schedules later review.</Text>
      <Button label="Try the sample session" variant="secondary" onPress={() => router.push('/preview')} />
      <Button label="Edit track and syllabus" variant="secondary" onPress={() => router.push('/study/preferences')} />
    </Card>
    <Card style={studyStyles.card}>
      <Text style={studyStyles.sectionTitle}>Connection or account trouble?</Text>
      <Text style={studyStyles.muted}>Downloaded material can be opened offline. Unsynced daily answers show a pending state and receive feedback after reconnection. Sign out clears private downloads from this device.</Text>
      <Text style={studyStyles.muted}>Use Account security for password changes, email verification and signing out other devices. Password recovery requires email delivery to be enabled by the service operator.</Text>
      <Button label="Account security" variant="secondary" onPress={() => router.push('/account/security')} />
    </Card>
    <Card style={studyStyles.card}>
      <Text style={studyStyles.sectionTitle}>Report a content problem</Text>
      <Text style={studyStyles.muted}>Open a course objective or a graded daily question and choose Report an issue. Current pilot material remains an editorial draft; follow its sources when checking an explanation.</Text>
      <Button label="Open course objectives" variant="secondary" onPress={() => router.push('/study/course')} />
    </Card>
    {isOperator ? <Card style={studyStyles.card}>
      <Text style={studyStyles.sectionTitle}>Operator: content report queue</Text>
      <Text style={studyStyles.muted}>Triage student reports across all accounts and mark them triaged or resolved. Resolve a report only after the content is corrected.</Text>
      <Button label="Open the reports queue" variant="secondary" onPress={() => router.push('/admin/reports')} />
    </Card> : null}
    <Text style={studyStyles.sectionTitle}>Your recent reports</Text>
    {loading ? <LoadingView label="Loading reports…" /> : null}
    {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
    {!loading && !error && reports.length === 0 ? <Text style={studyStyles.muted}>You have not submitted any content reports yet.</Text> : null}
    {reports.map((report) => <Card key={report.id} style={studyStyles.card}><View style={studyStyles.spread}>
      <Text style={[studyStyles.label, { flex: 1 }]}>{report.category === 'accuracy' ? 'Medical accuracy' : report.category === 'source' ? 'Source or citation' : report.category === 'unclear' ? 'Unclear explanation' : 'Other issue'}</Text>
      <Badge label={report.status} />
    </View><Text style={studyStyles.caption}>{report.concept_id.replaceAll('-', ' ')} · {new Date(report.created_at).toLocaleDateString()}</Text></Card>)}
    <Button label="Back to Today" variant="secondary" onPress={() => router.replace('/today')} />
  </StudyPage>;
}
