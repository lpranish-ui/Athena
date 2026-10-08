import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LoadError } from '@/components/LoadError';
import { Badge, Button, Card, ErrorBanner, LoadingView } from '@/components/ui';
import { ConceptStatus, EnrollmentForm, ReviewNote, SourceLinks, StudyPage, studyError, studyStyles } from '@/components/study/StudyUI';
import { getStudyCourse, getStudyCourses, getStudyDashboard, saveStudyEnrollment } from '@/lib/study';
import { colors, withAlpha } from '@/theme';
import type { CourseDetail, CourseEnrollment } from '@/types/study';

export default function StudyCourseScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ courseId?: string; conceptId?: string; settings?: string }>();
  const [course, setCourse] = useState<CourseDetail | null>(null);
  const [enrollment, setEnrollment] = useState<CourseEnrollment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedChoice, setExpandedChoice] = useState<{ requestedId?: string; selectedId: string | null }>({ requestedId: params.conceptId, selectedId: params.conceptId || null });
  const [settingsChoice, setSettingsChoice] = useState({ request: params.settings, open: params.settings === '1' });
  const [saved, setSaved] = useState(false);
  const request = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const scrolledToConcept = useRef<string | null>(null);
  const expanded = expandedChoice.requestedId === params.conceptId ? expandedChoice.selectedId : params.conceptId || null;
  const settingsOpen = settingsChoice.request === params.settings ? settingsChoice.open : params.settings === '1';

  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const dashboard = await getStudyDashboard();
      const courseId = params.courseId || dashboard.course?.id || (await getStudyCourses())[0]?.id;
      if (!courseId) throw new Error('No course pack is available yet. Please try again later.');
      const detail = dashboard.course?.id === courseId ? dashboard.course : await getStudyCourse(courseId);
      if (version !== request.current) return;
      setCourse(detail);
      setEnrollment(dashboard.enrollment?.course_id === courseId ? dashboard.enrollment : null);
      setError(null);
    } catch (err) {
      if (version === request.current) setError(studyError(err, 'Could not load the course.'));
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [params.courseId]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { request.current += 1; };
  }, [load]));

  if (loading) return <LoadingView label="Opening the course syllabus…" />;

  return (
    <StudyPage scrollRef={scroll}>
      <Stack.Screen options={{ title: 'Your course' }} />
      {!course && error ? <LoadError message={error} onRetry={() => { setLoading(true); void load(); }} /> : null}
      {course ? (
        <>
          <View style={{ gap: 12 }}>
            <Badge label={`${course.subject.toUpperCase()} · ${course.version}`} />
            <Text style={studyStyles.title}>{course.title}</Text>
            <Text style={studyStyles.muted}>{course.description}</Text>
            <Text style={studyStyles.caption}>{course.objective_count} objectives · {course.question_count} original questions · Source links included</Text>
            {course.review_status === 'draft' ? <ReviewNote note={course.review_note} /> : null}
            {course.review_status === 'reviewed' ? <Text style={studyStyles.caption}>Reviewed by {course.reviewed_by} · {course.reviewed_at} · Version {course.version}</Text> : null}
          </View>
          {error ? <LoadError message={error} onRetry={() => void load()} /> : null}

          <Card style={studyStyles.card}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: settingsOpen || !enrollment }}
              aria-expanded={settingsOpen || !enrollment}
              onPress={() => { setSettingsChoice({ request: params.settings, open: !settingsOpen }); setSaved(false); }}
              style={studyStyles.spread}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={studyStyles.sectionTitle}>{enrollment ? 'Study plan settings' : 'Make this your course'}</Text>
                {enrollment ? <Text style={studyStyles.caption}>{enrollment.daily_minutes} minutes per day{enrollment.exam_date ? ` · Exam ${enrollment.exam_date}` : ''}</Text> : null}
              </View>
              <Ionicons name={settingsOpen || !enrollment ? 'chevron-up' : 'options-outline'} size={21} color={colors.primary} />
            </Pressable>
            {settingsOpen || !enrollment ? (
              <EnrollmentForm
                key={`${enrollment?.course_id || 'new'}-${enrollment?.daily_minutes || ''}-${enrollment?.exam_date || ''}`}
                courseId={course.id}
                enrollment={enrollment}
                label={enrollment ? 'Save study plan' : 'Set up study plan'}
                onSave={async (input) => {
                  const updated = await saveStudyEnrollment(input);
                  setEnrollment(updated);
                  setSaved(true);
                }}
              />
            ) : null}
            {saved ? (
              <View style={{ gap: 10 }}>
                <Text accessibilityRole="alert" style={[studyStyles.muted, { color: colors.success }]}>Your study plan is saved. Changes apply to your next new session.</Text>
                <Button label="Go to today’s plan" icon="arrow-forward" onPress={() => router.replace('/today')} />
              </View>
            ) : null}
          </Card>

          <View style={{ gap: 6 }}>
            <Text style={studyStyles.sectionTitle}>Course objectives</Text>
            <Text style={studyStyles.muted}>Open an objective to read its lesson and follow the sources. Secure recall needs evidence on separate study days.</Text>
            <Button label="Map my own syllabus" variant="secondary" onPress={() => router.push('/study/syllabus')} />
          </View>
          {course.concepts.map((concept, index) => {
            const open = expanded === concept.id;
            return (
              <View key={concept.id} onLayout={(event) => {
                if (params.conceptId === concept.id && scrolledToConcept.current !== concept.id) {
                  scrolledToConcept.current = concept.id;
                  scroll.current?.scrollTo({ y: Math.max(0, event.nativeEvent.layout.y - 20), animated: false });
                }
              }}>
              <Card padded={false} style={styles.conceptCard}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  aria-expanded={open}
                  accessibilityLabel={`${concept.title}, ${concept.progress.status.replace('_', ' ')}`}
                  style={styles.conceptHeader}
                  onPress={() => setExpandedChoice({ requestedId: params.conceptId, selectedId: open ? null : concept.id })}
                >
                  <View style={styles.number}><Text style={styles.numberText}>{String(index + 1).padStart(2, '0')}</Text></View>
                  <View style={{ flex: 1, gap: 9 }}>
                    <Text style={studyStyles.label}>{concept.title}</Text>
                    <ConceptStatus status={concept.progress.status} />
                  </View>
                  <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
                </Pressable>
                {open ? (
                  <View style={styles.lesson}>
                    <View style={studyStyles.divider} />
                    <Text style={studyStyles.eyebrow}>LEARNING OBJECTIVE</Text>
                    <Text style={studyStyles.muted}>{concept.objective}</Text>
                    <Button label="Report an issue" variant="ghost" small onPress={() => router.push({ pathname: '/study/report', params: { courseId: course.id, conceptId: concept.id } })} />
                    {concept.lesson.split(/\n\s*\n/).map((paragraph, i) => <Text key={i} style={studyStyles.body}>{paragraph}</Text>)}
                    {concept.key_points.length ? (
                      <View style={styles.keyPoints}>
                        <Text style={studyStyles.label}>Keep in mind</Text>
                        {concept.key_points.map((point) => (
                          <View key={point} style={[studyStyles.row, { alignItems: 'flex-start' }]}>
                            <Text style={{ color: colors.primary, lineHeight: 25 }}>•</Text>
                            <Text style={[studyStyles.muted, { flex: 1 }]}>{point}</Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                    <Text style={studyStyles.caption}>{concept.progress.attempts} question attempts · {concept.progress.correct_count} correct{concept.progress.lesson_completed ? ' · Lesson completed' : ''}</Text>
                    <SourceLinks sources={concept.sources} />
                  </View>
                ) : null}
              </Card>
              </View>
            );
          })}
          {course.concepts.length === 0 ? <ErrorBanner message="This course has no learning objectives yet. Please refresh or choose another course." /> : null}
        </>
      ) : null}
    </StudyPage>
  );
}

const styles = StyleSheet.create({
  conceptCard: { borderRadius: 18, overflow: 'hidden' },
  conceptHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 18, minHeight: 95 },
  number: { alignSelf: 'flex-start', width: 34, height: 34, borderRadius: 10, backgroundColor: withAlpha(colors.primary, '12'), justifyContent: 'center', alignItems: 'center' },
  numberText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
  lesson: { padding: 18, paddingTop: 0, gap: 16 },
  keyPoints: { padding: 16, gap: 10, backgroundColor: withAlpha(colors.primary, '09'), borderRadius: 14 },
});
