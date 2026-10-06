import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { ProgressBar, ReviewNote, SourceLinks, Stat, studyError, studyStyles } from '@/components/study/StudyUI';
import { completeStudyStep, getStudySession } from '@/lib/study';
import { colors, withAlpha } from '@/theme';
import type { StudyMistake, StudySession } from '@/types/study';

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
  const [session, setSession] = useState<StudySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const request = useRef(0);
  const saveInFlight = useRef(false);
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
    }).catch((err: unknown) => {
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

  const step = session?.steps[viewIndex];
  const feedback = step?.feedback;
  const answered = !!step?.completed;
  const chosenOption = answered ? step?.answer?.option_index ?? selected : selected;
  const savedConfidence = step?.answer?.confidence;

  const saveStep = async () => {
    if (!session || !step || saveInFlight.current || step.completed) return;
    if (step.type === 'question' && (selected === null || confidence === null)) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const response = await completeStudyStep(session.id, step.id, step.type === 'question'
        ? { option_index: selected!, confidence: confidence! }
        : {});
      setSession(response.session);
      // The API advances immediately. Keep the answered question visible until Continue,
      // so the learner can read the saved explanation before moving on.
      if (step.type === 'lesson') moveTo(response.session.current_index);
    } catch (err) {
      setError(`${studyError(err, 'Could not save this step.')} Your progress will update only after it is saved. Retry below or reload the saved session.`);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
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
  const completedSteps = session?.steps.filter((item) => item.completed).length || 0;
  const answeredSteps = session?.steps.map((item, index) => ({ ...item, index })).filter((item) => item.type === 'question' && item.completed && item.feedback) || [];

  return (
    <Screen padded={false} edges={['left', 'right']}>
      <Stack.Screen options={{ title: complete ? 'Session recap' : 'Daily study session' }} />
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={studyStyles.page}>
        <View style={{ gap: 4 }}>
          {leaveControl}
          {session && !complete ? <Text style={studyStyles.caption}>Completed steps are saved. Submit an answer before leaving to save it.</Text> : null}
        </View>
        {!session && error ? <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} /> : null}
        {session ? (
          <>
            <View style={{ gap: 12 }}>
              <Text style={studyStyles.eyebrow}>{session.course_title.toUpperCase()}</Text>
              <View style={studyStyles.spread}>
                <Text style={studyStyles.caption}>{session.local_date} · {session.estimated_minutes} minute plan</Text>
                <Text style={studyStyles.caption}>{completedSteps}/{session.steps.length} saved</Text>
              </View>
              <ProgressBar value={session.steps.length ? completedSteps / session.steps.length * 100 : 0} label={`${completedSteps} of ${session.steps.length} steps saved`} />
            </View>

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
            ) : step ? (
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
                            accessibilityState={{ checked: chosen, disabled: answered || saving }}
                            aria-checked={chosen}
                            accessibilityLabel={`${chosen ? 'Your answer. ' : ''}${String.fromCharCode(65 + index)}. ${option}${correct ? '. Correct answer' : wrong ? '. Incorrect answer' : ''}`}
                            disabled={answered || saving}
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
                              disabled={saving}
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
                      </Card>
                    ) : null}
                  </>
                ) : <ErrorBanner message="This question is missing its content. Reload the session to try again." />}

                {error ? (
                  <View style={{ gap: 10 }}>
                    <ErrorBanner message={error} />
                    <Button label="Reload saved session" variant="secondary" icon="refresh-outline" loading={reloading} disabled={saving} onPress={reload} />
                  </View>
                ) : null}
                <Button
                  label={answered ? (session.status === 'completed' ? 'See session recap' : 'Continue') : step.type === 'lesson' ? 'I’ve read this · Continue' : 'Check answer'}
                  icon={answered || step.type === 'lesson' ? 'arrow-forward' : 'checkmark-outline'}
                  loading={saving}
                  disabled={reloading || (!answered && step.type === 'question' && (selected === null || confidence === null || !step.question))}
                  onPress={answered ? continueSession : () => void saveStep()}
                />
                {!answered && step.type === 'question' ? <Text style={[studyStyles.caption, { textAlign: 'center' }]}>Choose an answer and your confidence to continue.</Text> : null}
              </>
            ) : (
              <LoadError message="There is no current step in this session. Reload your saved plan to continue." onRetry={reload} />
            )}

            {answeredSteps.length ? (
              <Card style={studyStyles.card}>
                <Pressable accessibilityRole="button" accessibilityState={{ expanded: historyOpen }} aria-expanded={historyOpen} style={studyStyles.spread} onPress={() => setHistoryOpen(!historyOpen)}>
                  <Text style={[studyStyles.label, { flex: 1 }]}>{complete ? 'Review your answers' : 'Earlier answers'} ({answeredSteps.length})</Text>
                  <Ionicons name={historyOpen ? 'chevron-up' : 'chevron-down'} size={19} color={colors.primary} />
                </Pressable>
                {historyOpen ? answeredSteps.map((item) => (
                  <Pressable key={item.id} accessibilityRole="button" style={styles.historyRow} onPress={() => { moveTo(item.index); setHistoryOpen(false); }}>
                    <Ionicons name={item.feedback?.correct ? 'checkmark-circle-outline' : 'bulb-outline'} size={20} color={item.feedback?.correct ? colors.success : colors.warning} />
                    <Text style={[studyStyles.muted, { flex: 1 }]}>{item.question?.prompt || item.title}</Text>
                    <Ionicons name="chevron-forward" size={17} color={colors.textMuted} />
                  </Pressable>
                )) : null}
              </Card>
            ) : null}
            <ReviewNote />
            <Text style={studyStyles.caption}>Pack {session.pack_version} · Saved to your account after each completed step</Text>
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
