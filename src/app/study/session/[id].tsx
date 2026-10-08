import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { ProgressBar, ReviewNote, SourceLinks, Stat, studyError, studyStyles } from '@/components/study/StudyUI';
import { completeStudyStep, discardPendingStudyProgress, getDownloadedStudySession, getStudySession } from '@/lib/study';
import type { OfflineStudySession } from '@/lib/offlineStudy';
import { colors, withAlpha } from '@/theme';
import type { StudyMistake } from '@/types/study';

type Confidence = StudyMistake['confidence'];
const CONFIDENCE_CHOICES: { value: Confidence; label: string }[] = [
  { value: 'unsure', label: 'Unsure' },
  { value: 'okay', label: 'Somewhat sure' },
  { value: 'confident', label: 'Confident' },
];
const STEP_LABELS = { new: 'BUILD UNDERSTANDING', review: 'RETRIEVE FROM MEMORY', repair: 'REPAIR A MISUNDERSTANDING', exit: 'CHECK YOUR UNDERSTANDING' };

export default function StudySessionScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [session, setSession] = useState<OfflineStudySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const request = useRef(0);
  const saveInFlight = useRef(false);
  const syncInFlight = useRef(false);
  const scroll = useRef<ScrollView>(null);

  const moveTo = (index: number) => {
    setViewIndex(index);
    setSelected(null);
    setConfidence(null);
    setError(null);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  const load = useCallback(() => {
    const version = ++request.current;
    const result = id ? getStudySession(id) : Promise.reject(new Error('This study session link is incomplete. Open your session from Today.'));
    return result.then((data) => {
      if (version !== request.current) return;
      setSession(data);
      setViewIndex(data.status === 'completed' ? data.steps.length : data.current_index);
      setSelected(null);
      setConfidence(null);
      setError(null);
      setConflict(false);
    }).catch(async (err: unknown) => {
      if (version !== request.current) return;
      if (err instanceof Error && 'status' in err && err.status === 409 && id) {
        try {
          const local = await getDownloadedStudySession(id);
          if (version !== request.current) return;
          if (local) { setSession(local); setViewIndex(local.current_index); setConflict(true); }
        } catch (storageError) {
          if (version === request.current) setError(studyError(storageError, 'Could not open locally saved choices.'));
          return;
        }
      }
      if (version === request.current) setError(studyError(err, 'Could not load this study session.'));
    }).finally(() => {
      if (version === request.current) {
        setLoading(false);
        setReloading(false);
      }
    });
  }, [id]);

  const reload = () => {
    setReloading(true);
    void load();
  };

  useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]);

  const sync = useCallback(async () => {
    if (!id || syncInFlight.current || saveInFlight.current) return;
    const version = request.current;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      const value = await getStudySession(id);
      if (version !== request.current) return;
      setSession(value);
      setError(null);
      setConflict(false);
    } catch (err) {
      if (version !== request.current) return;
      setError(studyError(err, 'Your locally saved answers are waiting to sync.'));
      setConflict(err instanceof Error && 'status' in err && err.status === 409);
    } finally {
      syncInFlight.current = false;
      if (version === request.current) setSyncing(false);
    }
  }, [id]);

  const pendingCount = session?.offline?.pending_steps.length ?? 0;
  useEffect(() => {
    if (!pendingCount) return;
    const interval = setInterval(() => { void sync(); }, 30000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') void sync(); });
    const retry = () => { void sync(); };
    if (Platform.OS === 'web') globalThis.addEventListener?.('online', retry);
    return () => {
      clearInterval(interval);
      subscription.remove();
      if (Platform.OS === 'web') globalThis.removeEventListener?.('online', retry);
    };
  }, [pendingCount, sync]);

  const step = session?.steps[viewIndex];
  const feedback = step?.feedback;
  const pending = !!step && !!session?.offline?.pending_steps.includes(step.id);
  const answered = !!step?.completed || pending;
  const chosenOption = answered ? step?.answer?.option_index ?? selected : selected;
  const savedConfidence = step?.answer?.confidence;

  const saveStep = async () => {
    if (!session || !step || saveInFlight.current || syncInFlight.current || answered) return;
    if (step.type === 'question' && (selected === null || confidence === null)) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    const version = request.current;
    try {
      const response = await completeStudyStep(session.id, step.id, step.type === 'question'
        ? { option_index: selected!, confidence: confidence! }
        : {});
      if (version !== request.current) return;
      setSession(response.session as OfflineStudySession);
      // The API advances immediately. Keep the answered question visible until Continue,
      // so the learner can read the saved explanation before moving on.
      if (step.type === 'lesson') moveTo(response.session.current_index);
    } catch (err) {
      if (version !== request.current) return;
      setConflict(err instanceof Error && 'status' in err && err.status === 409);
      setError(`${studyError(err, 'Could not save this step.')} Your progress will update only after it is saved. Retry below or reload the saved session.`);
    } finally {
      saveInFlight.current = false;
      if (version === request.current) setSaving(false);
    }
  };

  const continueSession = () => {
    if (session) moveTo(session.status === 'completed' ? session.steps.length : session.current_index);
  };

  const leaveControl = (
    <Button label="Back to Today" icon="arrow-back" variant="ghost" disabled={saving} onPress={() => router.replace('/today')} style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }} />
  );

  if (loading) return (
    <Screen padded={false} edges={['left', 'right']}>
      <View style={{ paddingHorizontal: 20 }}>{leaveControl}</View>
      <LoadingView label="Opening your saved study session…" />
    </Screen>
  );

  const complete = session?.status === 'completed' && viewIndex >= session.steps.length;
  const waitingForSync = !!session && viewIndex >= session.steps.length && pendingCount > 0;
  const completedSteps = session?.steps.filter((item) => item.completed).length || 0;
  const savedSteps = completedSteps + pendingCount;
  const answeredSteps = session?.steps.map((item, index) => ({ ...item, index })).filter((item) => item.type === 'question' && (item.completed && item.feedback || session.offline?.pending_steps.includes(item.id))) || [];

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: complete ? 'Session recap' : 'Daily study session' }} />
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={studyStyles.page}>
        <View style={{ gap: 4 }}>
          {leaveControl}
          {session && !complete ? <Text style={studyStyles.caption}>Submit each answer to save it. Keep this session open or reopen it when you reconnect to sync local work.</Text> : null}
        </View>
        {!session && error ? <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} /> : null}
        {session ? (
          <>
            <View style={{ gap: 12 }}>
              <Text style={studyStyles.eyebrow}>{session.course_title.toUpperCase()}</Text>
              <View style={studyStyles.spread}>
                <Text style={studyStyles.caption}>{session.local_date} · {session.estimated_minutes} minute plan</Text>
                <Text style={studyStyles.caption}>{savedSteps}/{session.steps.length} saved{pendingCount ? ` · ${pendingCount} pending sync` : ''}</Text>
              </View>
              <ProgressBar value={session.steps.length ? savedSteps / session.steps.length * 100 : 0} label={`${savedSteps} of ${session.steps.length} steps saved, ${pendingCount} pending sync`} />
            </View>

            {session.offline?.cached || pendingCount ? (
              <Card style={studyStyles.card}>
                <Badge label={pendingCount ? 'SAVED ON THIS DEVICE' : 'DOWNLOADED SESSION'} color={colors.warning} />
                <Text style={studyStyles.muted}>{pendingCount ? `${pendingCount} step${pendingCount === 1 ? '' : 's'} await server sync. Answers and confidence are stored locally; grading and learning progress update after sync.` : 'You are reading a downloaded session. Reconnect to refresh your account progress.'}</Text>
                <Text style={studyStyles.caption}>Keep this account signed in until sync completes. Signing out removes private downloads and unsynced work.</Text>
                <Button label="Sync now" icon="sync-outline" variant="secondary" loading={syncing} disabled={saving || reloading} onPress={() => void sync()} />
              </Card>
            ) : null}

            {waitingForSync ? (
              <Card style={studyStyles.card}>
                <Text style={studyStyles.heading}>Your practice is saved locally.</Text>
                <Text style={studyStyles.muted}>You reached the end of this downloaded plan. Connect to receive explanations, grading, and your session recap.</Text>
                <Button label="Back to Today" onPress={() => router.replace('/today')} />
              </Card>
            ) : null}

            {complete ? (
              <>
                <Card style={[studyStyles.card, styles.summary]}>
                  <View style={styles.completedIcon}><Ionicons name="checkmark-done-outline" size={34} color={colors.primary} /></View>
                  <Badge label="PROGRESS SAVED" />
                  <Text style={studyStyles.title}>A little clearer today.</Text>
                  <Text style={studyStyles.muted}>You finished your plan. What you recalled and what you missed will guide your next session.</Text>
                  <View style={styles.stats}>
                    <Stat value={session.summary.concepts_practiced} label="Concepts practiced" />
                    <Stat value={`${session.summary.correct_answers}/${session.summary.questions_answered}`} label="Questions correct" />
                  </View>
                  <Text style={studyStyles.caption}>A single session is practice evidence. Correct recall on later study days helps an objective become secure.</Text>
                  <Button label="Back to today" icon="arrow-forward" onPress={() => router.replace('/today')} />
                  <Button label="Review mistake journal" variant="secondary" icon="bookmarks-outline" onPress={() => router.push('/study/mistakes')} />
                </Card>
              </>
            ) : waitingForSync ? null : step ? (
              <>
                <View style={{ gap: 10 }}>
                  <Text style={studyStyles.caption}>STEP {viewIndex + 1} OF {session.steps.length} · {step.estimated_minutes} MIN</Text>
                  <Badge label={STEP_LABELS[step.kind]} color={step.kind === 'repair' ? colors.warning : colors.primary} />
                  <Text style={studyStyles.heading}>{step.title}</Text>
                </View>

                {step.type === 'lesson' ? (
                  <Card style={studyStyles.card}>
                    {(step.lesson || '').split(/\n\s*\n/).map((paragraph, index) => <Text key={index} style={studyStyles.body}>{paragraph}</Text>)}
                    {step.key_points?.length ? (
                      <View style={styles.keyPoints}>
                        <Text style={studyStyles.label}>Keep these connections</Text>
                        {step.key_points.map((point) => (
                          <View key={point} style={[studyStyles.row, { alignItems: 'flex-start' }]}>
                            <Text style={{ color: colors.primary, lineHeight: 25 }}>•</Text>
                            <Text style={[studyStyles.muted, { flex: 1 }]}>{point}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <SourceLinks sources={step.sources} />
                    <Text style={studyStyles.caption}>Pause and explain the idea in your own words before continuing.</Text>
                  </Card>
                ) : step.question ? (
                  <>
                    <Card style={studyStyles.card}>
                      <Text style={[studyStyles.body, { fontWeight: '600' }]}>{step.question.prompt}</Text>
                    </Card>
                    <View accessibilityRole="radiogroup" style={{ gap: 10 }}>
                      {step.question.options.map((option, index) => {
                        const chosen = chosenOption === index;
                        const correct = !!feedback && feedback.correct_index === index;
                        const wrong = !!feedback && chosen && !correct;
                        return (
                          <Pressable
                            key={`${step.id}-${index}`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: chosen, disabled: answered || saving || syncing }}
                            aria-checked={chosen}
                            accessibilityLabel={`${chosen ? 'Your answer. ' : ''}${String.fromCharCode(65 + index)}. ${option}${correct ? '. Correct answer' : wrong ? '. Incorrect answer' : ''}`}
                            disabled={answered || saving || syncing}
                            onPress={() => { setSelected(index); setError(null); }}
                            style={({ pressed }) => [styles.option, chosen && styles.optionSelected, correct && styles.optionCorrect, wrong && styles.optionWrong, pressed && { opacity: 0.8 }]}
                          >
                            <View style={[styles.optionLetter, correct && { backgroundColor: withAlpha(colors.success, '20') }, wrong && { backgroundColor: withAlpha(colors.danger, '20') }]}>
                              <Text style={[styles.optionLetterText, correct && { color: colors.success }, wrong && { color: colors.danger }]}>{String.fromCharCode(65 + index)}</Text>
                            </View>
                            <Text style={[studyStyles.body, { flex: 1, fontSize: 15, lineHeight: 23 }]}>{option}</Text>
                            {correct ? <Ionicons name="checkmark-circle" size={21} color={colors.success} /> : wrong ? <Ionicons name="close-circle" size={21} color={colors.danger} /> : chosen ? <Ionicons name="radio-button-on" size={20} color={colors.primary} /> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                    {!answered ? (
                      <View style={{ gap: 12 }}>
                        <Text style={studyStyles.label}>How sure are you?</Text>
                        <View style={styles.confidences} accessibilityRole="radiogroup">
                          {CONFIDENCE_CHOICES.map((choice) => (
                            <Pressable
                              key={choice.value}
                              accessibilityRole="radio"
                              accessibilityState={{ checked: confidence === choice.value, disabled: saving }}
                              aria-checked={confidence === choice.value}
                              disabled={saving || syncing}
                              onPress={() => setConfidence(choice.value)}
                              style={[styles.confidence, confidence === choice.value && styles.confidenceSelected]}
                            >
                              <Text style={[styles.confidenceText, confidence === choice.value && { color: colors.primary }]}>{choice.label}</Text>
                            </Pressable>
                          ))}
                        </View>
                        <Text style={studyStyles.caption}>Confidence helps you notice answers you understood and answers you guessed.</Text>
                      </View>
                    ) : null}
                    {feedback ? (
                      <Card style={[studyStyles.card, feedback.correct ? styles.feedbackCorrect : styles.feedbackRepair]}>
                        <View style={studyStyles.row}>
                          <Ionicons name={feedback.correct ? 'checkmark-circle-outline' : 'bulb-outline'} size={24} color={feedback.correct ? colors.success : colors.warning} />
                          <Text style={[studyStyles.sectionTitle, { flex: 1 }]}>{feedback.correct ? 'Correct — here’s the connection' : 'Let’s untangle this'}</Text>
                        </View>
                        <Text style={studyStyles.body}>{feedback.explanation}</Text>
                        {savedConfidence ? <Text style={studyStyles.caption}>Your confidence: {CONFIDENCE_CHOICES.find((choice) => choice.value === savedConfidence)?.label}</Text> : null}
                        {feedback.misconception ? (
                          <View style={{ gap: 7 }}>
                            <Text style={studyStyles.label}>Watch for this misunderstanding</Text>
                            <Text style={studyStyles.muted}>{feedback.misconception}</Text>
                          </View>
                        ) : null}
                        <SourceLinks sources={feedback.sources} />
                        <Text style={[studyStyles.caption, { color: colors.primary }]}>Answer saved{feedback.correct ? '.' : ' to your mistake journal for later practice.'}</Text>
                        <Button label="Report this question" variant="ghost" small icon="flag-outline" onPress={() => router.push({ pathname: '/study/report', params: { courseId: session.course_id, conceptId: step.concept_id, questionId: step.question?.id, sessionId: session.id } })} />
                      </Card>
                    ) : null}
                    {pending && !feedback ? <Card style={studyStyles.card}><Text style={studyStyles.label}>Answer and confidence saved locally</Text><Text style={studyStyles.muted}>Continue with the downloaded plan. Your explanation will be available after the server grades this answer.</Text><Text style={studyStyles.caption}>Your confidence: {CONFIDENCE_CHOICES.find((choice) => choice.value === savedConfidence)?.label}</Text></Card> : null}
                  </>
                ) : <ErrorBanner message="This question is missing its content. Reload the session to try again." />}

                {error ? (
                  <View style={{ gap: 10 }}>
                    <ErrorBanner message={error} />
                    <Button label="Reload saved session" variant="secondary" icon="refresh-outline" loading={reloading} disabled={saving} onPress={reload} />
                  </View>
                ) : null}
                <Button
                  label={answered ? (session.status === 'completed' ? 'See session recap' : 'Continue') : step.type === 'lesson' ? 'I’ve read this · Continue' : session.offline?.cached ? 'Save answer' : 'Check answer'}
                  icon={answered || step.type === 'lesson' ? 'arrow-forward' : 'checkmark-outline'}
                  loading={saving}
                  disabled={reloading || syncing || (!answered && step.type === 'question' && (selected === null || confidence === null || !step.question))}
                  onPress={answered ? continueSession : () => void saveStep()}
                />
                {!answered && step.type === 'question' ? <Text style={[studyStyles.caption, { textAlign: 'center' }]}>Choose an answer and your confidence to continue.</Text> : null}
              </>
            ) : (
              <LoadError message="There is no current step in this session. Reload your saved plan to continue." onRetry={reload} />
            )}

            {waitingForSync && error ? <ErrorBanner message={error} /> : null}
            {conflict ? <Card style={studyStyles.card}><Text style={studyStyles.muted}>Your local choices were kept. To discard unsynced choices and use answers already saved on the server, select the button below.</Text><Button label="Discard local choices · use server progress" variant="secondary" loading={reloading} disabled={saving || syncing} onPress={() => { if (!id) return; setReloading(true); const version = request.current; void discardPendingStudyProgress(id).then((value) => { if (version !== request.current) return; setSession(value); moveTo(value.status === 'completed' ? value.steps.length : value.current_index); setConflict(false); }).catch((err) => { if (version === request.current) setError(studyError(err, 'Could not load server progress. Your choices remain saved locally.')); }).finally(() => { if (version === request.current) setReloading(false); }); }} /></Card> : null}

            {answeredSteps.length ? (
              <Card style={studyStyles.card}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: historyOpen }} aria-expanded={historyOpen} style={studyStyles.spread} onPress={() => setHistoryOpen(!historyOpen)}>
                  <Text style={[studyStyles.label, { flex: 1 }]}>{complete ? 'Review your answers' : 'Saved answers'} ({answeredSteps.length})</Text>
                  <Ionicons name={historyOpen ? 'chevron-up' : 'chevron-down'} size={19} color={colors.primary} />
                </Pressable>
                {historyOpen ? answeredSteps.map((item) => (
                  <Pressable key={item.id} accessibilityRole="button" style={styles.historyRow} onPress={() => { moveTo(item.index); setHistoryOpen(false); }}>
                    <Ionicons name={session.offline?.pending_steps.includes(item.id) ? 'time-outline' : item.feedback?.correct ? 'checkmark-circle-outline' : 'bulb-outline'} size={20} color={item.feedback?.correct ? colors.success : colors.warning} />
                    <Text style={[studyStyles.muted, { flex: 1 }]}>{item.question?.prompt || item.title}{session.offline?.pending_steps.includes(item.id) ? ' · awaiting sync' : ''}</Text>
                    <Ionicons name="chevron-forward" size={17} color={colors.textMuted} />
                  </Pressable>
                )) : null}
              </Card>
            ) : null}
            {session.review_status === 'reviewed' ? <Text style={studyStyles.caption}>Reviewed by {session.reviewed_by} · {session.reviewed_at}</Text> : <ReviewNote note={session.review_note} />}
            <Text style={studyStyles.caption}>Pack {session.pack_version} · {pendingCount ? 'Unsynced steps are saved on this device' : 'Synced steps are saved to your account'}</Text>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { backgroundColor: '#102B31', borderColor: '#23535A', gap: 20 },
  completedIcon: { width: 68, height: 68, backgroundColor: withAlpha(colors.primary, '15'), borderRadius: 22, justifyContent: 'center', alignItems: 'center' },
  stats: { flexDirection: 'row', gap: 20, paddingVertical: 6 },
  keyPoints: { padding: 16, gap: 10, backgroundColor: withAlpha(colors.primary, '09'), borderRadius: 14 },
  option: { flexDirection: 'row', alignItems: 'center', minHeight: 68, gap: 12, padding: 15, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16 },
  optionSelected: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '0A') },
  optionCorrect: { borderColor: colors.success, backgroundColor: withAlpha(colors.success, '0B') },
  optionWrong: { borderColor: colors.danger, backgroundColor: withAlpha(colors.danger, '0B') },
  optionLetter: { width: 31, height: 31, borderRadius: 9, backgroundColor: colors.surfaceAlt, justifyContent: 'center', alignItems: 'center' },
  optionLetterText: { color: colors.textMuted, fontSize: 13, fontWeight: '800' },
  confidences: { flexDirection: 'row', gap: 8 },
  confidence: { flex: 1, minHeight: 48, paddingHorizontal: 8, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  confidenceSelected: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '10') },
  confidenceText: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  feedbackCorrect: { backgroundColor: '#122A29', borderColor: '#285E46' },
  feedbackRepair: { backgroundColor: '#28281F', borderColor: '#5D5030' },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border, minHeight: 56 },
});
