import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode, type Ref } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Screen } from '@/components/Screen';
import { Badge, Button, ErrorBanner, Input } from '@/components/ui';
import { colors, withAlpha } from '@/theme';
import type { ConceptProgress, CourseEnrollment, StudySource } from '@/types/study';

export function StudyPage({ children, style, scrollRef }: { children: ReactNode; style?: StyleProp<ViewStyle>; scrollRef?: Ref<ScrollView> }) {
  return (
    <Screen padded={false} edges={['left', 'right']}>
      <ScrollView ref={scrollRef} keyboardShouldPersistTaps="handled" contentContainerStyle={[studyStyles.page, style]}>
        {children}
      </ScrollView>
    </Screen>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, value));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      style={styles.progressTrack}
    >
      <View style={[styles.progressFill, { width: `${percent}%` }]} />
    </View>
  );
}

export function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function ReviewNote({ note }: { note?: string }) {
  return (
    <View style={styles.reviewNote}>
      <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
      <Text style={styles.reviewText}>{note || 'Original draft pack. Editorial review pending.'}</Text>
    </View>
  );
}

const STATUS_LABELS: Record<ConceptProgress['status'], string> = {
  new: 'New', learning: 'Learning', needs_review: 'Needs review', secure: 'Secure',
};

export function ConceptStatus({ status }: { status: ConceptProgress['status'] }) {
  const color = status === 'secure' ? colors.success : status === 'needs_review' ? colors.warning : status === 'new' ? colors.textMuted : colors.primary;
  return <Badge label={STATUS_LABELS[status]} color={color} />;
}

export function SourceLinks({ sources }: { sources: StudySource[] }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (source: StudySource) => {
    try {
      setError(null);
      await Linking.openURL(source.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this source. Try the link again.');
    }
  };
  if (sources.length === 0) return null;
  return (
    <View style={styles.sources}>
      <Text style={studyStyles.eyebrow}>READ THE SOURCE</Text>
      {sources.map((source) => (
        <Pressable
          key={`${source.url}-${source.section || ''}`}
          accessibilityRole="link"
          accessibilityLabel={`Open ${source.title}${source.section ? `, ${source.section}` : ''}`}
          onPress={() => void open(source)}
          style={({ pressed }) => [styles.source, pressed && { opacity: 0.75 }]}
        >
          <Ionicons name="book-outline" size={18} color={colors.primary} />
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.sourceTitle}>{source.title}</Text>
            {source.section ? <Text style={studyStyles.caption}>{source.section}</Text> : null}
          </View>
          <Ionicons name="open-outline" size={16} color={colors.textMuted} />
        </Pressable>
      ))}
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}

export function EnrollmentForm({
  courseId,
  enrollment,
  label = 'Set up study plan',
  onSave,
}: {
  courseId: string;
  enrollment?: CourseEnrollment | null;
  label?: string;
  onSave: (input: { course_id: string; daily_minutes: number; exam_date: string | null }) => Promise<void>;
}) {
  const [minutes, setMinutes] = useState(enrollment?.daily_minutes || 20);
  const [examDate, setExamDate] = useState(enrollment?.exam_date || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const date = examDate.trim();
    if (date && !isValidStudyDate(date)) {
      setError('Enter a real date as YYYY-MM-DD, or leave it blank.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ course_id: courseId, daily_minutes: minutes, exam_date: date || null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your plan. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={studyStyles.gap}>
      <Text style={studyStyles.label}>How much time do you have each day?</Text>
      <View style={styles.budgets}>
        {[10, 20, 30].map((value) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: minutes === value, disabled: saving }}
            aria-checked={minutes === value}
            accessibilityLabel={`${value} minutes per day`}
            disabled={saving}
            onPress={() => setMinutes(value)}
            style={[styles.budget, minutes === value && styles.budgetSelected]}
          >
            <Text style={[styles.budgetValue, minutes === value && { color: colors.primary }]}>{value}</Text>
            <Text style={studyStyles.caption}>min / day</Text>
          </Pressable>
        ))}
      </View>
      <Input
        label="Exam date (optional)"
        placeholder="YYYY-MM-DD"
        accessibilityLabel="Exam date, optional, YYYY-MM-DD"
        value={examDate}
        onChangeText={setExamDate}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={10}
        editable={!saving}
      />
      <Text style={studyStyles.caption}>A small, repeatable session is a good place to start. You can change these settings later.</Text>
      {error ? <ErrorBanner message={error} /> : null}
      <Button label={label} icon="arrow-forward" loading={saving} onPress={() => void save()} />
    </View>
  );
}

function isValidStudyDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function studyError(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export const studyStyles = StyleSheet.create({
  page: { padding: 20, paddingTop: 24, paddingBottom: 48, gap: 20 },
  gap: { gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  eyebrow: { color: colors.primary, fontSize: 11, letterSpacing: 1.5, fontWeight: '800' },
  title: { color: colors.text, fontSize: 30, lineHeight: 36, fontWeight: '800', letterSpacing: -0.7 },
  heading: { color: colors.text, fontSize: 21, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  sectionTitle: { color: colors.text, fontSize: 18, lineHeight: 25, fontWeight: '700' },
  label: { color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: '700' },
  body: { color: colors.text, fontSize: 16, lineHeight: 26 },
  muted: { color: colors.textMuted, fontSize: 14, lineHeight: 22 },
  caption: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  card: { padding: 20, gap: 16, borderRadius: 22 },
  divider: { height: 1, backgroundColor: colors.border },
  link: { color: colors.primary, fontSize: 14, fontWeight: '700' },
  linkButton: { minHeight: 44, justifyContent: 'center', paddingVertical: 10 },
});

const styles = StyleSheet.create({
  progressTrack: { height: 6, width: '100%', backgroundColor: colors.border, overflow: 'hidden', borderRadius: 4 },
  progressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 4 },
  stat: { flex: 1, gap: 4 },
  statValue: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  reviewNote: { flexDirection: 'row', gap: 7, alignItems: 'flex-start' },
  reviewText: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  sources: { gap: 8, marginTop: 4 },
  source: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, backgroundColor: colors.surfaceAlt, padding: 12, minHeight: 52 },
  sourceTitle: { color: colors.primary, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  budgets: { flexDirection: 'row', gap: 10 },
  budget: { flex: 1, minHeight: 84, alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: colors.surfaceAlt, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  budgetSelected: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '12') },
  budgetValue: { color: colors.text, fontSize: 24, fontWeight: '800' },
});
