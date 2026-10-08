import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Screen } from '@/components/Screen';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { StudyTrackPicker } from '@/components/study/StudyTrackPicker';
import { EnrollmentForm, ProgressBar, ReviewNote, Stat, studyError, studyStyles } from '@/components/study/StudyUI';
import { getStudyCourses, getStudyDashboard, saveStudyEnrollment, startStudySession, type OfflineStudyDashboard } from '@/lib/study';
import { getStudyPreferences, getStudyTrack, saveStudyPreferences, SHARED_PILOT_NOTE, type StudyPreferences, type StudyTrack } from '@/lib/tracks';
import { colors, withAlpha } from '@/theme';
import type { CourseSummary } from '@/types/study';

export default function TodayScreen() {
  const router = useRouter();
  const [dashboard, setDashboard] = useState<OfflineStudyDashboard | null>(null);
  const [pack, setPack] = useState<CourseSummary | null>(null);
  const [preferences, setPreferences] = useState<StudyPreferences | null>(null);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);
  const [track, setTrack] = useState<StudyTrack>('mbbs');
  const [goal, setGoal] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const [planResult, preferencesResult] = await Promise.allSettled([getStudyDashboard(), getStudyPreferences()]);
      if (version !== request.current) return;
      if (preferencesResult.status === 'fulfilled') {
        setPreferences(preferencesResult.value);
        setTrack(preferencesResult.value.track);
        setGoal(preferencesResult.value.goal || '');
        setPreferencesError(null);
      } else {
        setPreferencesError(studyError(preferencesResult.reason, 'Could not load your study goals.'));
      }
      if (planResult.status === 'rejected') throw planResult.reason;
      const data = planResult.value;
      const courses = data.enrollment ? null : await getStudyCourses();
      if (version !== request.current) return;
      setDashboard(data);
      setPack(data.course || courses?.[0] || null);
      setError(null);
    } catch (err) {
      if (version === request.current) setError(studyError(err, 'Could not load your study plan.'));
    } finally {
      if (version === request.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]));

  const openSession = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const sessionId = dashboard?.today?.id || (await startStudySession()).id;
      router.push({ pathname: '/study/session/[id]', params: { id: sessionId } });
    } catch (err) {
      setError(studyError(err, 'Could not start your session. Please try again.'));
    } finally {
      setStarting(false);
    }
  };

  const date = (dashboard?.local_date ? new Date(`${dashboard.local_date}T12:00:00`) : new Date())
    .toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const course = dashboard?.course;
  const enrollment = dashboard?.enrollment;
  const summary = dashboard?.summary;
  const today = dashboard?.today;
  const pendingSteps = dashboard?.offline?.pending_steps || 0;
  const syncMessage = dashboard?.offline?.sync_message;
  const unresolved = dashboard?.mistakes.filter((mistake) => !mistake.resolved) || [];
  const unresolvedConcepts = new Set(unresolved.map((mistake) => mistake.concept_id)).size;
  const daysUntilExam = enrollment?.exam_date && dashboard?.local_date
    ? Math.round((Date.parse(`${enrollment.exam_date}T00:00:00Z`) - Date.parse(`${dashboard.local_date}T00:00:00Z`)) / 86400000)
    : null;
  const recentSessions = dashboard?.recent_sessions?.filter((item) => item.id !== today?.id).slice(0, 3) || [];

  if (loading) return <LoadingView label="Building your study day…" />;

  return (
    <Screen padded={false}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={studyStyles.page}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} onRefresh={() => { setRefreshing(true); void load(); }} />}
      >
        <View style={studyStyles.spread}>
          <View style={{ gap: 5, flex: 1 }}>
            <Text style={studyStyles.eyebrow}>YOUR DAILY PRACTICE</Text>
            <Text style={studyStyles.title}>Today</Text>
            <Text style={studyStyles.muted}>{date}</Text>
          </View>
          <View style={styles.brandMark}><Ionicons name="pulse-outline" size={30} color={colors.primary} /></View>
        </View>

        {!dashboard && error ? <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} /> : null}
        {dashboard && error ? (
          <View style={{ gap: 8 }}>
            <ErrorBanner message={error} />
            <Button label="Refresh study plan" variant="secondary" icon="refresh-outline" onPress={() => void load()} />
          </View>
        ) : null}

        {dashboard?.offline?.cached ? (
          <Card style={studyStyles.card}>
            <Badge label="SAVED PLAN · OFFLINE" color={colors.warning} />
            <Text style={studyStyles.muted}>Connect to create a new plan. Previously downloaded sessions can continue offline; answers sync for grading.</Text>
            <Text style={studyStyles.caption}>Saved {new Date(dashboard.offline.saved_at).toLocaleString()}. Session counts reflect the last synced plan.</Text>
          </Card>
        ) : null}

        {pendingSteps > 0 || syncMessage ? (
          <Card style={studyStyles.card}>
            <Badge label={pendingSteps > 0 ? `${pendingSteps} ${pendingSteps === 1 ? 'ANSWER' : 'ANSWERS'} WAITING FOR GRADING` : 'SYNC NEEDS ATTENTION'} color={colors.warning} />
            <Text style={studyStyles.muted}>Your local answers are kept. Progress and recall totals update after the server grades them.</Text>
            {syncMessage ? <Text accessibilityRole="alert" style={studyStyles.muted}>{syncMessage}</Text> : null}
            {today ? (
              <>
                <Text style={studyStyles.caption}>Open your saved session to finish syncing or review conflicting answers.</Text>
                <Button label="Open saved session" variant="secondary" icon="play-outline" onPress={() => router.push({ pathname: '/study/session/[id]', params: { id: today.id } })} />
              </>
            ) : null}
          </Card>
        ) : null}

        {dashboard && !enrollment && pack ? (
          <>
            <Card style={[studyStyles.card, styles.hero]}>
              <Badge label="YOUR FIRST COURSE" />
              <Text style={styles.heroTitle}>Make a little time. Build lasting recall.</Text>
              <Text style={studyStyles.muted}>A focused plan connects short lessons, practice questions, and the concepts you need to revisit.</Text>
              <View style={styles.flow}>
                {['Understand', 'Practice', 'Repair'].map((label, index) => (
                  <View key={label} style={styles.flowItem}>
                    <View style={styles.flowNumber}><Text style={styles.flowNumberText}>{index + 1}</Text></View>
                    <Text style={styles.flowLabel}>{label}</Text>
                  </View>
                ))}
              </View>
              <Button label="Try a two-minute preview" variant="secondary" icon="play-outline" onPress={() => router.push('/preview')} />
            </Card>
            <Card style={studyStyles.card}>
              <Text style={studyStyles.eyebrow}>YOUR DIRECTION</Text>
              <Text style={studyStyles.sectionTitle}>Choose your study goal</Text>
              {preferences ? (
                <>
                  <StudyTrackPicker track={track} goal={goal} onTrackChange={setTrack} onGoalChange={setGoal} disabled={starting} />
                  <Text style={studyStyles.caption}>Your selection saves when you start your first session.</Text>
                </>
              ) : null}
              {preferencesError ? <LoadError message={preferencesError} onRetry={() => void load()} /> : null}
              <Text style={studyStyles.caption}>{SHARED_PILOT_NOTE}</Text>
              <Button label="Edit goals or bring your syllabus" variant="ghost" icon="map-outline" onPress={() => router.push('/study/preferences')} />
            </Card>
            <Card style={studyStyles.card}>
              <View style={studyStyles.row}>
                <View style={styles.courseIcon}><Ionicons name="heart-outline" size={24} color={colors.primary} /></View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={studyStyles.eyebrow}>{pack.subject.toUpperCase()}</Text>
                  <Text style={studyStyles.sectionTitle}>{pack.title}</Text>
                </View>
              </View>
              <Text style={studyStyles.muted}>{pack.description}</Text>
              <Text style={studyStyles.caption}>{pack.objective_count} learning objectives · {pack.question_count} original practice questions</Text>
              <Pressable accessibilityRole="link" style={studyStyles.linkButton} onPress={() => router.push({ pathname: '/study/course', params: { courseId: pack.id } })}>
                <Text style={studyStyles.link}>Explore the syllabus and sources →</Text>
              </Pressable>
              <View style={studyStyles.divider} />
              {preferences ? (
                <EnrollmentForm courseId={pack.id} label="Start my first session" onSave={async (input) => {
                  setStarting(true);
                  setError(null);
                  try {
                    await saveStudyPreferences({ track, goal: goal.trim() || null, syllabus_text: preferences.syllabus_text });
                    await saveStudyEnrollment(input);
                    const session = await startStudySession();
                    router.push({ pathname: '/study/session/[id]', params: { id: session.id } });
                  } catch (err) {
                    // An enrollment can succeed before session creation fails.
                    await load();
                    setError(studyError(err, 'Could not start your first session. Please try again.'));
                    throw err;
                  } finally {
                    setStarting(false);
                  }
                }} />
              ) : <Text style={studyStyles.caption}>Load your study goals above to start a saved plan.</Text>}
              {pack.review_status === 'draft' ? <ReviewNote note={pack.review_note} /> : null}
            </Card>
          </>
        ) : null}

        {dashboard && !enrollment && !pack ? (
          <Card style={studyStyles.card}>
            <Text style={studyStyles.sectionTitle}>Your course pack is not available yet</Text>
            <Text style={studyStyles.muted}>Refresh to check again, or continue with your own books in the library.</Text>
            <Button label="Refresh courses" variant="secondary" onPress={() => void load()} />
            <Button label="Open library" variant="ghost" onPress={() => router.push('/library')} />
          </Card>
        ) : null}

        {course && enrollment && summary ? (
          <>
            <Card style={[studyStyles.card, styles.hero]}>
              <View style={studyStyles.spread}>
                <Badge label={pendingSteps > 0 ? 'ANSWERS SAVED LOCALLY' : today?.status === 'completed' ? 'TODAY COMPLETE' : today ? 'READY TO RESUME' : 'YOUR NEXT SESSION'} />
                <View style={studyStyles.row}>
                  <Ionicons name="time-outline" size={15} color={colors.textMuted} />
                  <Text style={studyStyles.caption}>{today?.estimated_minutes || enrollment.daily_minutes} min</Text>
                </View>
              </View>
              <Text style={styles.heroTitle}>{pendingSteps > 0 ? 'Your answers are saved.' : today?.status === 'completed' ? 'Good work today.' : today ? 'Pick up where you left off.' : 'One session. A clearer understanding.'}</Text>
              <Text style={studyStyles.muted}>{pendingSteps > 0
                ? 'Resume your saved session to finish practice or sync answers for grading.'
                : today?.status === 'completed'
                ? 'Your progress is saved. Give your memory time to work; a new plan will be ready tomorrow.'
                : 'A short lesson, a few questions, and focused repair where you need it.'}</Text>
              {today ? (
                <View style={{ gap: 8 }}>
                  <ProgressBar value={today.total_steps ? today.completed_steps / today.total_steps * 100 : 0} label={`${today.completed_steps} of ${today.total_steps} session steps completed`} />
                  <Text style={studyStyles.caption}>{today.completed_steps} of {today.total_steps} steps synced</Text>
                </View>
              ) : null}
              <Button
                label={pendingSteps > 0 ? 'Resume session to sync' : today?.status === 'completed' ? 'See session recap' : today ? 'Resume session' : 'Start today’s session'}
                icon={!pendingSteps && today?.status === 'completed' ? 'checkmark-circle-outline' : 'arrow-forward'}
                loading={starting}
                disabled={!!dashboard?.offline?.cached && !today}
                onPress={() => void openSession()}
              />
              <Text style={studyStyles.caption}>Your answers save after each step. Come back whenever you need to.</Text>
            </Card>

            <Card style={studyStyles.card}>
              <View style={studyStyles.row}>
                <Ionicons name="compass-outline" size={23} color={colors.accent} />
                <Text style={[studyStyles.sectionTitle, { flex: 1 }]}>{preferences ? getStudyTrack(preferences.track).title : 'Your study goals'}</Text>
              </View>
              {preferences?.goal ? <Text style={studyStyles.body}>{preferences.goal}</Text> : <Text style={studyStyles.muted}>Keep your daily practice connected to your coursework or exam goal.</Text>}
              {preferencesError ? <LoadError message={preferencesError} onRetry={() => void load()} /> : null}
              <Text style={studyStyles.caption}>{SHARED_PILOT_NOTE}</Text>
              <Button label="Edit goals & syllabus" variant="secondary" icon="options-outline" onPress={() => router.push('/study/preferences')} />
              <Button label="View your objective map" variant="ghost" icon="map-outline" onPress={() => router.push('/study/syllabus')} />
            </Card>

            <Card style={studyStyles.card}>
              <View style={studyStyles.spread}>
                <View style={{ flex: 1, gap: 5 }}>
                  <Text style={studyStyles.eyebrow}>YOUR COURSE</Text>
                  <Text style={studyStyles.sectionTitle}>{course.title}</Text>
                </View>
                <Ionicons name="heart-outline" size={25} color={colors.primary} />
              </View>
              <View style={styles.stats}>
                <Stat value={`${summary.practiced_objectives}/${summary.total_objectives}`} label="Objectives practiced" />
                <Stat value={summary.secure_objectives} label="Secure recall" />
                <Stat value={summary.completed_sessions} label="Sessions completed" />
              </View>
              <ProgressBar value={summary.total_objectives ? summary.practiced_objectives / summary.total_objectives * 100 : 0} label="Course objectives practiced" />
              <Text style={studyStyles.caption}>Secure recall reflects correct practice on separate days after mistakes are repaired.</Text>
              <View style={styles.courseLinks}>
                <Button label="View syllabus" variant="secondary" icon="map-outline" onPress={() => router.push('/study/course')} style={{ flex: 1 }} />
                <Pressable accessibilityRole="button" accessibilityLabel="Edit study plan" style={styles.settings} onPress={() => router.push({ pathname: '/study/course', params: { settings: '1' } })}>
                  <Ionicons name="options-outline" size={21} color={colors.primary} />
                </Pressable>
              </View>
              <Text style={studyStyles.caption}>{enrollment.daily_minutes} minutes each day{enrollment.exam_date ? ` · Exam ${enrollment.exam_date}` : ''}</Text>
              {daysUntilExam !== null ? (
                <View style={styles.examNote}>
                  <Ionicons name="calendar-outline" size={18} color={colors.accent} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={studyStyles.label}>{daysUntilExam < 0 ? 'Your exam date has passed' : daysUntilExam === 0 ? 'Your assessment is today' : `${daysUntilExam} ${daysUntilExam === 1 ? 'day' : 'days'} until your assessment`}</Text>
                    <Text style={studyStyles.caption}>{summary.total_objectives - summary.practiced_objectives} objectives still to practice{daysUntilExam < 0 ? ' · Update your date in study plan settings.' : '. Use your syllabus map to see your coverage.'}</Text>
                  </View>
                </View>
              ) : null}
            </Card>

            {recentSessions.length ? (
              <Card style={studyStyles.card}>
                <Text style={studyStyles.sectionTitle}>Recent sessions</Text>
                {recentSessions.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="link"
                    accessibilityLabel={`${item.status === 'active' ? 'Resume' : 'Review'} session from ${item.local_date}`}
                    onPress={() => router.push({ pathname: '/study/session/[id]', params: { id: item.id } })}
                    style={styles.recentRow}
                  >
                    <Ionicons name={item.status === 'active' ? 'play-circle-outline' : 'checkmark-circle-outline'} size={23} color={item.status === 'active' ? colors.primary : colors.textMuted} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={studyStyles.label}>{item.local_date}</Text>
                      <Text style={studyStyles.caption}>{item.completed_steps}/{item.total_steps} steps saved · {item.estimated_minutes} min</Text>
                    </View>
                    <Text style={studyStyles.link}>{item.status === 'active' ? 'Resume' : 'Recap'}</Text>
                  </Pressable>
                ))}
              </Card>
            ) : null}

            {dashboard.recommended_concepts.length ? (
              <View style={{ gap: 12 }}>
                <Text style={studyStyles.sectionTitle}>Where to focus</Text>
                {dashboard.recommended_concepts.slice(0, 3).map((concept, index) => (
                  <Pressable
                    key={concept.id}
                    accessibilityRole="link"
                    onPress={() => router.push({ pathname: '/study/course', params: { conceptId: concept.id } })}
                    style={({ pressed }) => [styles.focusRow, pressed && { opacity: 0.8 }]}
                  >
                    <Text style={styles.focusIndex}>{String(index + 1).padStart(2, '0')}</Text>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={studyStyles.label}>{concept.title}</Text>
                      <Text style={studyStyles.caption}>{concept.reason}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={17} color={colors.textMuted} />
                  </Pressable>
                ))}
              </View>
            ) : null}

            <Card style={studyStyles.card}>
              <View style={studyStyles.row}>
                <Ionicons name="bulb-outline" size={23} color={colors.warning} />
                <Text style={[studyStyles.sectionTitle, { flex: 1 }]}>Learn from your mistakes</Text>
              </View>
              {unresolved.length ? (
                <>
                  <Text style={studyStyles.muted}>{unresolvedConcepts} {unresolvedConcepts === 1 ? 'concept needs' : 'concepts need'} another look. Your next sessions use these to choose focused practice.</Text>
                  <View style={styles.mistakePreview}>
                    <Text style={studyStyles.label}>{unresolved[0].concept_title}</Text>
                    <Text style={studyStyles.muted} numberOfLines={3}>{unresolved[0].misconception || unresolved[0].explanation}</Text>
                  </View>
                </>
              ) : <Text style={studyStyles.muted}>Missed questions become a personal repair journal, with explanations and source links you can revisit.</Text>}
              <Button label="Open mistake journal" variant="secondary" icon="bookmarks-outline" onPress={() => router.push('/study/mistakes')} />
            </Card>
            {course.review_status === 'draft' ? <ReviewNote note={course.review_note} /> : null}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brandMark: { width: 58, height: 58, borderRadius: 19, backgroundColor: withAlpha(colors.primary, '12'), borderWidth: 1, borderColor: withAlpha(colors.primary, '30'), justifyContent: 'center', alignItems: 'center' },
  hero: { backgroundColor: '#102B31', borderColor: '#23535A', gap: 18 },
  heroTitle: { color: colors.text, fontSize: 28, fontWeight: '800', lineHeight: 35, letterSpacing: -0.65 },
  flow: { flexDirection: 'row', gap: 10, paddingVertical: 6 },
  flowItem: { flex: 1, gap: 9 },
  flowNumber: { width: 30, height: 30, borderRadius: 10, backgroundColor: withAlpha(colors.primary, '1A'), justifyContent: 'center', alignItems: 'center' },
  flowNumberText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  flowLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
  courseIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: withAlpha(colors.primary, '15'), justifyContent: 'center', alignItems: 'center' },
  stats: { flexDirection: 'row', gap: 16, paddingVertical: 6 },
  courseLinks: { flexDirection: 'row', gap: 10 },
  settings: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surfaceAlt },
  focusRow: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 16, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  focusIndex: { color: colors.primary, fontSize: 18, fontWeight: '800', minWidth: 28 },
  mistakePreview: { paddingLeft: 12, borderLeftWidth: 2, borderColor: colors.warning, gap: 5 },
  examNote: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: 12, backgroundColor: withAlpha(colors.accent, '0A') },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border, minHeight: 58 },
});
