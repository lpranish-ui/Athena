// Profile — identity, study profile (country + target exam), progress by
// subject and weak chapters, and account deletion.

import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/Screen';
import { Button, Card, ErrorBanner, Input } from '@/components/ui';
import { deleteAccount } from '@/lib/api';
import { api } from '@/lib/apiClient';
import { useAuth } from '@/lib/auth';
import { initials } from '@/lib/format';
import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';
import type { Profile } from '@/types';

const EXAM_SUGGESTIONS = [
  'USMLE Step 1',
  'USMLE Step 2 CK',
  'NEET-PG',
  'PLAB 1',
  'NExT',
  'FMGE',
  'Final MBBS',
];

/** Friendly "days to go" label for the study planner. */
function examDaysLabelFor(dateText: string): string | null {
  const trimmed = dateText.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const diff = Math.ceil((new Date(`${trimmed}T00:00:00`).getTime() - Date.now()) / 86_400_000);
  if (!Number.isFinite(diff)) return null;
  return diff >= 0 ? `${diff} days to go` : 'This date is in the past';
}

interface SubjectStat {
  subject: string;
  attempts: number;
  avg: number;
}

interface ChapterStat {
  key: string;
  title: string;
  book: string;
  avg: number;
  questions: number;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const [fullName, setFullName] = useState('');
  const [school, setSchool] = useState('');
  const [year, setYear] = useState('');
  const [country, setCountry] = useState('');
  const [targetExam, setTargetExam] = useState('');
  const [examDate, setExamDate] = useState('');
  const [examDaysLabel, setExamDaysLabel] = useState<string | null>(null);
  const [stats, setStats] = useState({ books: 0, attempts: 0, avg: 0 });
  const [subjectStats, setSubjectStats] = useState<SubjectStat[]>([]);
  const [weakChapters, setWeakChapters] = useState<ChapterStat[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;

    try {
      const [profile, progress, books] = await Promise.all([
        api.get<Profile | null>('/api/profile'),
        api.get<{
          count: number;
          attempts: {
            score: number;
            total: number;
            chapter_id: string | null;
            chapter_title: string | null;
            book_title: string | null;
            book_subject: string | null;
          }[];
        }>('/api/attempts'),
        api.get<{ is_default: boolean; owner_id: string | null }[]>('/api/books'),
      ]);

      if (profile) {
        setFullName(profile.full_name ?? '');
        setSchool(profile.school ?? '');
        setYear(profile.year_of_study ? String(profile.year_of_study) : '');
        setCountry(profile.country ?? '');
        setTargetExam(profile.target_exam ?? '');
        setExamDate(profile.exam_date ?? '');
        setExamDaysLabel(profile.exam_date ? examDaysLabelFor(profile.exam_date) : null);
      }

      const rows = progress.attempts;
      const totalQuestions = rows.reduce((sum, row) => sum + row.total, 0);
      const totalScore = rows.reduce((sum, row) => sum + row.score, 0);

      setStats({
        books: books.filter((book) => !book.is_default && book.owner_id === user.id).length,
        attempts: progress.count,
        avg: totalQuestions > 0 ? Math.round((totalScore / totalQuestions) * 100) : 0,
      });

      // Progress by subject + weak chapters.
      const subjects = new Map<string, { score: number; total: number; attempts: number }>();
      const chapters = new Map<string, ChapterStat & { score: number; total: number }>();

      for (const row of rows) {
        if (!row.chapter_id) continue;
        const subject = row.book_subject ?? 'General';

        const subjectEntry = subjects.get(subject) ?? { score: 0, total: 0, attempts: 0 };
        subjectEntry.score += row.score;
        subjectEntry.total += row.total;
        subjectEntry.attempts += 1;
        subjects.set(subject, subjectEntry);

        const chapterEntry = chapters.get(row.chapter_id) ?? {
          key: row.chapter_id,
          title: row.chapter_title ?? 'Chapter',
          book: row.book_title ?? 'Book',
          avg: 0,
          questions: 0,
          score: 0,
          total: 0,
        };
        chapterEntry.score += row.score;
        chapterEntry.total += row.total;
        chapterEntry.questions = chapterEntry.total;
        chapterEntry.avg =
          chapterEntry.total > 0 ? Math.round((chapterEntry.score / chapterEntry.total) * 100) : 0;
        chapters.set(row.chapter_id, chapterEntry);
      }

      setSubjectStats(
        [...subjects.entries()]
          .map(([subject, entry]) => ({
            subject,
            attempts: entry.attempts,
            avg: entry.total > 0 ? Math.round((entry.score / entry.total) * 100) : 0,
          }))
          .sort((a, b) => b.attempts - a.attempts)
          .slice(0, 6),
      );

      setWeakChapters(
        [...chapters.values()]
          .filter((chapter) => chapter.questions >= 5 && chapter.avg < 70)
          .sort((a, b) => a.avg - b.avg)
          .slice(0, 5)
          .map(({ key, title, book, avg, questions }) => ({ key, title, book, avg, questions })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your profile.');
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const save = async () => {
    if (!user) return;
    setSaving(true);
    setError(null);
    setSaved(false);

    const parsedYear = Number.parseInt(year, 10);
    const validExamDate = /^\d{4}-\d{2}-\d{2}$/.test(examDate.trim());

    try {
      await api.put('/api/profile', {
        full_name: fullName.trim() || null,
        school: school.trim() || null,
        year_of_study: Number.isFinite(parsedYear) ? parsedYear : null,
        country: country.trim() || null,
        target_exam: targetExam.trim() || null,
        exam_date: validExamDate ? examDate.trim() : null,
      });
      setSaved(true);
      setExamDaysLabel(examDaysLabelFor(examDate));
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile.');
    }
    setSaving(false);
  };

  const doDeleteAccount = async () => {
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      await signOut();
      // The auth listener signs the user out and the app redirects.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete your account.');
      setDeleting(false);
    }
  };

  const confirmDeleteAccount = () => {
    const message =
      'This permanently deletes your account, your uploaded books and every quiz you have made. This cannot be undone.';
    if (Platform.OS === 'web') {
      const confirmFn = (globalThis as { confirm?: (text: string) => boolean }).confirm;
      if (!confirmFn || confirmFn(`Delete your account?\n\n${message}`)) {
        void doDeleteAccount();
      }
      return;
    }
    Alert.alert('Delete your account?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete account', style: 'destructive', onPress: () => void doDeleteAccount() },
    ]);
  };

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Profile</Text>

        <View style={styles.identity}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(fullName || user?.email || 'Athena')}</Text>
          </View>
          <View style={styles.identityText}>
            <Text style={styles.name}>{fullName || 'Medical student'}</Text>
            <Text style={styles.email}>{user?.email}</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <StatCard label="Books uploaded" value={String(stats.books)} />
          <StatCard label="Quizzes taken" value={String(stats.attempts)} />
          <StatCard label="Avg score" value={`${stats.avg}%`} />
        </View>

        {subjectStats.length > 0 || weakChapters.length > 0 ? (
          <Card style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="trending-up-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Progress</Text>
            </View>

            {subjectStats.length > 0 ? (
              <View style={styles.subjectList}>
                <Text style={styles.subLabel}>By subject</Text>
                {subjectStats.map((stat) => (
                  <View key={stat.subject} style={styles.subjectRow}>
                    <Text style={styles.subjectName} numberOfLines={1}>
                      {stat.subject}
                    </Text>
                    <View style={styles.subjectBarWrap}>
                      <View
                        style={[
                          styles.subjectBarFill,
                          {
                            width: `${stat.avg}%`,
                            backgroundColor:
                              stat.avg >= 70
                                ? colors.success
                                : stat.avg >= 50
                                  ? colors.warning
                                  : colors.danger,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.subjectAvg}>{stat.avg}%</Text>
                  </View>
                ))}
              </View>
            ) : null}

            {weakChapters.length > 0 ? (
              <View style={styles.subjectList}>
                <Text style={styles.subLabel}>Study next (weakest chapters)</Text>
                {weakChapters.map((chapter) => (
                  <View key={chapter.key} style={styles.weakRow}>
                    <Ionicons name="alert-circle-outline" size={16} color={colors.warning} />
                    <View style={styles.weakText}>
                      <Text style={styles.weakTitle} numberOfLines={1}>
                        {chapter.title}
                      </Text>
                      <Text style={styles.weakMeta} numberOfLines={1}>
                        {chapter.book} · {chapter.questions} answers
                      </Text>
                    </View>
                    <Text style={styles.weakPct}>{chapter.avg}%</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}

        <Card style={styles.card}>
          <Text style={styles.cardTitle}>About you</Text>
          {error ? <ErrorBanner message={error} /> : null}
          <Input
            label="Full name"
            value={fullName}
            onChangeText={setFullName}
            placeholder="Jane Doe"
            autoCapitalize="words"
          />
          <Input
            label="Medical school (optional)"
            value={school}
            onChangeText={setSchool}
            placeholder="University of Medicine"
          />
          <Input
            label="Year of study (optional)"
            value={year}
            onChangeText={setYear}
            placeholder="e.g. 3"
            keyboardType="number-pad"
          />
          <Input
            label="Country (optional)"
            value={country}
            onChangeText={setCountry}
            placeholder="e.g. India"
            autoCapitalize="words"
          />
          <Input
            label="Target exam (drives question style)"
            value={targetExam}
            onChangeText={setTargetExam}
            placeholder="e.g. USMLE Step 1"
            autoCapitalize="words"
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {EXAM_SUGGESTIONS.map((exam) => {
              const active = targetExam === exam;
              return (
                <Pressable
                  key={exam}
                  onPress={() => setTargetExam(exam)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{exam}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Input
            label="Exam date (YYYY-MM-DD)"
            value={examDate}
            onChangeText={setExamDate}
            placeholder="e.g. 2027-06-15"
          />
          {examDaysLabel ? <Text style={styles.examHint}>{examDaysLabel}</Text> : null}
          <Button label={saved ? 'Saved ✓' : 'Save profile'} onPress={save} loading={saving} />
        </Card>

        <Button label="Study track & syllabus" variant="secondary" icon="school-outline" onPress={() => router.push('/study/preferences')} />
        <Button label="Account security" variant="secondary" icon="shield-checkmark-outline" onPress={() => router.push('/account/security')} />
        <Button label="Help & content reports" variant="secondary" icon="help-circle-outline" onPress={() => router.push('/help')} />
        <Button
          label="Sign out"
          variant="secondary"
          icon="log-out-outline"
          onPress={() => {
            void signOut();
          }}
        />

        <Pressable
          disabled={deleting}
          onPress={confirmDeleteAccount}
          style={styles.deleteRow}
        >
          <Text style={styles.deleteText}>
            {deleting ? 'Deleting account…' : 'Delete my account'}
          </Text>
        </Pressable>

        <Text style={styles.footer}>Athena · your daily medical study plan</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 20,
    paddingBottom: 48,
    gap: spacing.lg,
    maxWidth: 620,
    width: '100%',
    alignSelf: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.3,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: withAlpha(colors.primary, '26'),
    borderWidth: 1,
    borderColor: withAlpha(colors.primary, '66'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.primary,
    fontSize: 22,
    fontWeight: '800',
  },
  identityText: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  email: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  stat: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    color: colors.primary,
    fontSize: 22,
    fontWeight: '800',
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
  },
  card: {
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  subLabel: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  subjectList: {
    gap: spacing.sm,
  },
  subjectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  subjectName: {
    color: colors.text,
    fontSize: fontSize.sm,
    width: 110,
  },
  subjectBarWrap: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceAlt,
    overflow: 'hidden',
  },
  subjectBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  subjectAvg: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '700',
    width: 38,
    textAlign: 'right',
  },
  weakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  weakText: {
    flex: 1,
  },
  weakTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  weakMeta: {
    color: colors.textMuted,
    fontSize: 11,
  },
  weakPct: {
    color: colors.warning,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  chipRow: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: withAlpha(colors.primary, '1F'),
  },
  chipText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  chipTextActive: {
    color: colors.primary,
    fontWeight: '800',
  },
  examHint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  deleteRow: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  deleteText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  footer: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    textAlign: 'center',
  },
});
