import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { StudyTrackPicker } from '@/components/study/StudyTrackPicker';
import { StudyPage, studyStyles } from '@/components/study/StudyUI';
import { Button, Card, ErrorBanner, Input, LoadingView } from '@/components/ui';
import {
  getStudyPreferences, importStudySyllabus, MAX_SYLLABUS_LENGTH,
  saveStudyPreferences, SHARED_PILOT_NOTE, syllabusImportError,
  type StudyPreferences, type StudyTrack,
} from '@/lib/tracks';
import { colors } from '@/theme';

export default function StudyPreferencesScreen() {
  const router = useRouter();
  const [preferences, setPreferences] = useState<StudyPreferences | null>(null);
  const [track, setTrack] = useState<StudyTrack>('mbbs');
  const [goal, setGoal] = useState('');
  const [syllabus, setSyllabus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => getStudyPreferences()
    .then((data) => {
      setPreferences(data);
      setTrack(data.track);
      setGoal(data.goal || '');
      setSyllabus(data.syllabus_text || '');
      setError(null);
    })
    .catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not load your study preferences.');
    })
    .finally(() => {
      setLoading(false);
    }), []);

  useEffect(() => { void load(); }, [load]);

  const save = async (mapSyllabus = false) => {
    if (busy) return;
    const text = syllabus.trim();
    if (mapSyllabus) {
      const validation = syllabusImportError(text);
      if (validation) { setError(validation); return; }
    }
    setBusy(mapSyllabus ? 'import' : 'save');
    setError(null);
    setSaved(false);
    try {
      const data = await saveStudyPreferences({ track, goal: goal.trim() || null, syllabus_text: text || null });
      setPreferences(data);
      setSaved(true);
      if (mapSyllabus) {
        await importStudySyllabus(text);
        router.push('/study/syllabus');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your preferences. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const changed = () => { setSaved(false); setError(null); };

  if (loading) return <LoadingView label="Opening your study goals…" />;
  if (!preferences) return <StudyPage><LoadError message={error || 'Could not load your preferences.'} onRetry={() => { setLoading(true); void load(); }} /></StudyPage>;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StudyPage>
        <Stack.Screen options={{ title: 'Study goals & syllabus' }} />
        <Text style={studyStyles.eyebrow}>YOUR DIRECTION</Text>
        <Text style={studyStyles.title}>Make room for your goal.</Text>
        <Text style={studyStyles.muted}>Choose the path that fits your studies. You can update it as your goals change.</Text>
        <Card style={studyStyles.card}>
          <StudyTrackPicker
            track={track} goal={goal} disabled={busy !== null}
            onTrackChange={(value) => { setTrack(value); changed(); }}
            onGoalChange={(value) => { setGoal(value); changed(); }}
          />
          <Text style={studyStyles.caption}>{SHARED_PILOT_NOTE}</Text>
        </Card>
        <Card style={studyStyles.card}>
          <Text style={studyStyles.sectionTitle}>Bring your own syllabus</Text>
          <Text style={studyStyles.muted}>Paste learning objectives from your coursework or exam plan, one per line. Save them as notes, or import up to 100 objectives to map against available lessons.</Text>
          <Input
            label="Your learning objectives (optional)"
            accessibilityLabel="Your syllabus, one learning objective per line"
            value={syllabus}
            onChangeText={(value) => { setSyllabus(value); changed(); }}
            placeholder={'Trace blood flow through the heart\nExplain the determinants of cardiac output'}
            multiline textAlignVertical="top" maxLength={MAX_SYLLABUS_LENGTH}
            editable={busy === null} style={styles.syllabus}
          />
          <Text style={studyStyles.caption}>{syllabus.length.toLocaleString()} / {MAX_SYLLABUS_LENGTH.toLocaleString()} characters · Up to 200 characters per imported objective</Text>
          <Text style={studyStyles.caption}>Saving this text keeps your existing objective mappings. Importing replaces the previous objective list and mappings; you will confirm suggested matches on the next screen. A match does not mean your full syllabus is covered.</Text>
          {syllabus.trim() ? (
            <Button label="Save and map syllabus" variant="secondary" icon="map-outline" loading={busy === 'import'} disabled={busy !== null} onPress={() => void save(true)} />
          ) : null}
          <Button label="View objective mappings" variant="ghost" onPress={() => router.push('/study/syllabus')} disabled={busy !== null} />
        </Card>
        {error ? <ErrorBanner message={error} /> : null}
        {saved ? <Text accessibilityRole="alert" style={styles.saved}>Your study preferences are saved.</Text> : null}
        <Button label={saved ? 'Saved' : 'Save study preferences'} loading={busy === 'save'} disabled={busy !== null} onPress={() => void save()} />
        <Button label="Back to Today" variant="ghost" disabled={busy !== null} onPress={() => router.replace('/today')} />
      </StudyPage>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  syllabus: { minHeight: 190 },
  saved: { color: colors.success, lineHeight: 21 },
});
