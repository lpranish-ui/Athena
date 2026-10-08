import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Platform, Pressable, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Badge, Button, Card, ErrorBanner, Input, LoadingView } from '@/components/ui';
import { ConceptStatus, StudyPage, studyStyles } from '@/components/study/StudyUI';
import { getSyllabus, importSyllabus, saveSyllabusLinks, type SyllabusLink, type SyllabusMap } from '@/lib/curriculum';
import { colors, withAlpha } from '@/theme';

const key = (link: SyllabusLink) => `${link.course_id}:${link.concept_id}`;
export default function SyllabusScreen() {
  const [map, setMap] = useState<SyllabusMap | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [selected, setSelected] = useState<SyllabusLink[]>([]);
  const version = useRef(0);
  const load = useCallback(async () => {
    const current = ++version.current;
    try { const result = await getSyllabus(); if (current === version.current) { setMap(result); setError(null); } }
    catch (err) { if (current === version.current) setError(err instanceof Error ? err.message : 'Could not load your syllabus.'); }
    finally { if (current === version.current) setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); return () => { version.current++; }; }, [load]));
  async function replace() {
    if (busy) return;
    const current = ++version.current;
    setBusy('import'); setError(null);
    try { const result = await importSyllabus(text); if (current === version.current) { setMap(result); setText(''); setEditing(null); } }
    catch (err) { if (current === version.current) setError(err instanceof Error ? err.message : 'Could not import this syllabus.'); }
    finally { setBusy(null); }
  }
  function confirmImport() {
    if (!map?.items.length) { void replace(); return; }
    const message = 'Importing replaces your current objective list and confirmed mappings. Your study history is preserved.';
    if (Platform.OS === 'web') { if (globalThis.confirm(message)) void replace(); }
    else Alert.alert('Replace syllabus?', message, [{ text: 'Cancel', style: 'cancel' }, { text: 'Replace', onPress: () => void replace() }]);
  }
  async function save(id: string, links: SyllabusLink[]) {
    if (busy) return;
    const current = ++version.current;
    setBusy(id); setError(null);
    try { const result = await saveSyllabusLinks(id, links); if (current === version.current) { setMap(result); setEditing(null); } }
    catch (err) { if (current === version.current) setError(err instanceof Error ? err.message : 'Could not save this mapping.'); }
    finally { setBusy(null); }
  }
  return (
    <StudyPage>
      <Text style={studyStyles.eyebrow}>YOUR CURRICULUM</Text>
      <Text style={studyStyles.title}>Connect your syllabus</Text>
      <Text style={studyStyles.muted}>Confirm which available lessons support your learning objectives. Suggestions use matching words and need your judgment. A mapped topic shows available material, not complete exam coverage.</Text>
      {error ? <LoadError message={error} onRetry={() => void load()} /> : null}
      {loading ? <LoadingView label="Loading your syllabus…" /> : null}
      {map?.items.length ? <Card style={studyStyles.card}>
        <Text style={studyStyles.sectionTitle}>{map.summary.mapped} of {map.summary.total} objectives mapped</Text>
        <Text style={studyStyles.muted}>{map.summary.unmapped} still need a match. Unmatched topics remain visible so gaps are clear.</Text>
      </Card> : null}
      <Card style={studyStyles.card}>
        <Text style={studyStyles.sectionTitle}>{map?.items.length ? 'Replace objective list' : 'Import learning objectives'}</Text>
        <Input label="One objective per line" value={text} onChangeText={setText} multiline maxLength={20000}
          placeholder={'Trace blood flow through the heart\nExplain cardiac output\nDescribe renal filtration'}
          textAlignVertical="top" style={{ minHeight: 130 }} editable={!busy} />
        <Text style={studyStyles.caption}>Up to 100 objectives, 200 characters each. Existing mappings are replaced only when you import.</Text>
        <Button label="Import objectives" onPress={confirmImport} loading={busy === 'import'} disabled={loading || !text.trim() || !!busy} />
      </Card>
      {map?.items.map((item) => <Card key={item.id} style={studyStyles.card}>
        <View style={studyStyles.spread}><Text style={[studyStyles.label, { flex: 1 }]}>{item.title}</Text><Badge label={item.status === 'mapped' ? 'Mapped' : 'Needs a match'} color={item.status === 'mapped' ? colors.success : colors.warning} /></View>
        {item.links.map((link) => <Pressable key={key(link)} accessibilityRole="link" style={studyStyles.linkButton}
          onPress={() => router.push({ pathname: '/study/course', params: { courseId: link.course_id, conceptId: link.concept_id } })}>
          <Text style={studyStyles.link}>{link.concept_title}</Text>
          <ConceptStatus status={link.progress_status ?? 'new'} />
        </Pressable>)}
        {editing === item.id ? <View style={studyStyles.gap}>
          <Text style={studyStyles.caption}>Select up to five supporting objectives.</Text>
          {map.available_concepts.map((link) => {
            const checked = selected.some((choice) => key(choice) === key(link));
            return <Pressable key={key(link)} accessibilityRole="checkbox" accessibilityState={{ checked }} aria-checked={checked}
              disabled={!!busy || (!checked && selected.length >= 5)}
              onPress={() => setSelected((choices) => checked ? choices.filter((choice) => key(choice) !== key(link)) : [...choices, link])}
              style={{ padding: 14, minHeight: 48, borderRadius: 12, backgroundColor: checked ? withAlpha(colors.primary, '18') : colors.surfaceAlt, borderWidth: 1, borderColor: checked ? colors.primary : colors.border }}>
              <Text style={studyStyles.body}>{checked ? '✓ ' : ''}{link.concept_title}</Text>
            </Pressable>;
          })}
          <Button label="Save confirmed matches" loading={busy === item.id} disabled={!!busy} onPress={() => void save(item.id, selected)} />
          <Button label="Cancel" variant="ghost" disabled={!!busy} onPress={() => setEditing(null)} />
        </View> : <View style={studyStyles.gap}>
          {!item.links.length && item.suggestions.length ? <View style={studyStyles.gap}>
            <Text style={studyStyles.caption}>Possible matches — check before confirming:</Text>
            {item.suggestions.map((link) => <Button key={key(link)} label={`Confirm: ${link.concept_title}`} variant="secondary" small disabled={!!busy} onPress={() => void save(item.id, [link])} />)}
          </View> : null}
          {!item.links.length && !item.suggestions.length ? <Text style={studyStyles.caption}>No suggested match in the current pilot. Keep this objective as a visible coverage gap.</Text> : null}
          <Button label={item.links.length ? 'Edit matches' : 'Choose matches manually'} variant="ghost" disabled={!!busy} onPress={() => { setEditing(item.id); setSelected(item.links); }} />
        </View>}
      </Card>)}
      {!loading && !map?.items.length ? <ErrorBanner message="Your objective map is empty. Import your syllabus above, or paste it in Study preferences." /> : null}
      <Button label="Back to Today" variant="secondary" onPress={() => router.replace('/today')} />
    </StudyPage>
  );
}
