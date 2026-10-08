import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Button, Card, ErrorBanner, Input } from '@/components/ui';
import { StudyPage, studyStyles } from '@/components/study/StudyUI';
import { api } from '@/lib/apiClient';
import { colors } from '@/theme';

const categories = [{ id: 'accuracy', title: 'Medical accuracy' }, { id: 'source', title: 'Source or citation' }, { id: 'unclear', title: 'Unclear explanation' }, { id: 'other', title: 'Other issue' }];
export default function ContentReportScreen() {
  const params = useLocalSearchParams<{ courseId?: string; conceptId?: string; questionId?: string; sessionId?: string }>();
  const [category, setCategory] = useState('accuracy');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setError(null);
    try {
      await api.post('/api/study/reports', { course_id: params.courseId, concept_id: params.conceptId,
        question_id: params.questionId ?? null, session_id: params.sessionId ?? null, category, message: message.trim() });
      setSubmitted(true); setMessage('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send your report.'); }
    finally { setBusy(false); }
  }
  return <StudyPage>
    <Text style={studyStyles.title}>Help improve this material</Text>
    <Text style={studyStyles.muted}>Reports are saved for editorial triage. Please describe the issue and include a supporting source when possible. Do not include patient details or other private information.</Text>
    {submitted ? <Card style={studyStyles.card}>
      <Text accessibilityRole="alert" style={studyStyles.heading}>Report saved</Text>
      <Text style={studyStyles.muted}>You can see its status in Help & feedback. Submitting a report does not change the lesson or your saved answers.</Text>
      <Button label="Back to course" onPress={() => router.replace({ pathname: '/study/course', params: { courseId: params.courseId } })} />
    </Card> : <Card style={studyStyles.card}>
      {!params.courseId || !params.conceptId ? <ErrorBanner message="Open a lesson or graded question and choose Report an issue to identify the material." /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      <Text style={studyStyles.label}>What needs attention?</Text>
      <View style={studyStyles.gap}>{categories.map((item) => <Pressable key={item.id}
        accessibilityRole="radio" accessibilityState={{ checked: category === item.id }} aria-checked={category === item.id}
        disabled={busy} onPress={() => setCategory(item.id)} style={{ padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: category === item.id ? colors.primary : colors.border }}>
        <Text style={studyStyles.body}>{item.title}</Text>
      </Pressable>)}</View>
      <Input label="Describe the issue" value={message} onChangeText={setMessage} multiline maxLength={2000} textAlignVertical="top"
        style={{ minHeight: 130 }} editable={!busy} placeholder="Which statement needs correction, and why?" />
      <Text style={studyStyles.caption}>{message.length} / 2000 characters · minimum 10</Text>
      <Button label="Submit content report" loading={busy} disabled={!params.courseId || !params.conceptId || message.trim().length < 10} onPress={() => void submit()} />
    </Card>}
    <Button label="Back to Today" variant="secondary" onPress={() => router.replace('/today')} />
  </StudyPage>;
}
