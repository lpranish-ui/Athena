import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ReviewNote, SourceLinks, StudyPage, studyStyles } from '@/components/study/StudyUI';
import { Badge, Button, Card } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { STUDY_PREVIEW } from '@/lib/studyPreview';
import { colors, withAlpha } from '@/theme';

const CONFIDENCE = ['Unsure', 'Somewhat sure', 'Confident'];
const STEPS = ['Understand', 'Practice', 'Connect', 'Next step'];

export default function PreviewScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const scroll = useRef<ScrollView>(null);
  const [step, setStep] = useState(0);
  const [answer, setAnswer] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<string | null>(null);
  const correct = answer === STUDY_PREVIEW.correctIndex;

  const advance = (next: number) => {
    setStep(next);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };

  const restart = () => {
    setAnswer(null);
    setConfidence(null);
    advance(0);
  };

  return (
    <StudyPage scrollRef={scroll}>
      <Stack.Screen options={{ title: 'Try Athena' }} />
      <View style={studyStyles.spread}>
        <Badge label="PUBLIC PREVIEW" />
        <Text style={studyStyles.caption}>About 2 minutes</Text>
      </View>
      <Text accessibilityRole="header" style={studyStyles.title}>A small session. A clearer connection.</Text>
      <Text style={studyStyles.muted}>Try the same learning pattern used in Athena: understand a concept, practice recall, and untangle a mistake.</Text>
      <View accessibilityLabel={`Step ${step + 1} of 4: ${STEPS[step]}`} style={styles.steps}>
        {STEPS.map((label, index) => (
          <View key={label} style={styles.step}>
            <View style={[styles.dot, index <= step && styles.dotActive]}>
              <Text style={[styles.dotLabel, index <= step && { color: colors.primary }]}>{index + 1}</Text>
            </View>
            <Text style={[styles.stepLabel, index === step && { color: colors.text }]}>{label}</Text>
          </View>
        ))}
      </View>

      {step === 0 ? (
        <>
          <Card style={studyStyles.card}>
            <Text style={studyStyles.eyebrow}>ONE CONNECTION TO UNDERSTAND</Text>
            <Text accessibilityRole="header" style={studyStyles.sectionTitle}>{STUDY_PREVIEW.title}</Text>
            <Text style={studyStyles.body}>{STUDY_PREVIEW.lesson}</Text>
            <View style={styles.route}>
              {STUDY_PREVIEW.route.map((label, index) => (
                <View key={label} style={styles.routeItem}>
                  {index > 0 ? <Ionicons name="arrow-forward" size={16} color={colors.primary} /> : null}
                  <Text style={styles.routeLabel}>{label}</Text>
                </View>
              ))}
            </View>
            <SourceLinks sources={STUDY_PREVIEW.sources} />
          </Card>
          <Button label="Practice one question" icon="arrow-forward" onPress={() => advance(1)} />
        </>
      ) : null}

      {step === 1 ? (
        <>
          <Card style={studyStyles.card}>
            <Text style={studyStyles.eyebrow}>PRACTICE RECALL</Text>
            <Text accessibilityRole="header" style={studyStyles.sectionTitle}>{STUDY_PREVIEW.question}</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Question answer" style={studyStyles.gap}>
              {STUDY_PREVIEW.options.map((option, index) => (
                <Pressable
                  key={option} accessibilityRole="radio"
                  accessibilityState={{ checked: answer === index }} aria-checked={answer === index}
                  onPress={() => setAnswer(index)}
                  style={({ pressed }) => [styles.option, answer === index && styles.selected, pressed && styles.pressed]}
                >
                  <Text style={styles.optionLetter}>{String.fromCharCode(65 + index)}</Text>
                  <Text style={[studyStyles.body, styles.optionText]}>{option}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={studyStyles.label}>How sure are you?</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Answer confidence" style={styles.confidences}>
              {CONFIDENCE.map((label) => (
                <Pressable
                  key={label} accessibilityRole="radio"
                  accessibilityState={{ checked: confidence === label }} aria-checked={confidence === label}
                  onPress={() => setConfidence(label)}
                  style={({ pressed }) => [styles.confidence, confidence === label && styles.selected, pressed && styles.pressed]}
                >
                  <Text style={[studyStyles.caption, confidence === label && { color: colors.primary }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={studyStyles.caption}>Confidence helps you distinguish an understood answer from a guess.</Text>
          </Card>
          <Button label="Check my answer" disabled={answer === null || confidence === null} onPress={() => advance(2)} />
          <Text style={studyStyles.caption}>Choose an answer and your confidence to continue.</Text>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Card style={[studyStyles.card, correct ? styles.correct : styles.repair]}>
            <Badge label={correct ? 'CONNECTION MADE' : 'LET’S UNTANGLE THIS'} color={correct ? colors.success : colors.warning} />
            <Text accessibilityRole="header" style={studyStyles.sectionTitle}>{correct ? 'Correct — here’s the route.' : 'Follow the destination first.'}</Text>
            <Text style={studyStyles.caption}>You chose: {answer === null ? '' : STUDY_PREVIEW.options[answer]} · {confidence}</Text>
            {!correct && answer !== null ? <Text style={studyStyles.body}>{STUDY_PREVIEW.repairs[answer]}</Text> : null}
            <Text style={studyStyles.body}>{STUDY_PREVIEW.explanation}</Text>
            <SourceLinks sources={STUDY_PREVIEW.sources} />
          </Card>
          <Text style={studyStyles.muted}>In a full study session, missed concepts enter your mistake journal and shape later practice. One answer is a starting point; recall on later days matters too.</Text>
          <Button label="See what comes next" icon="arrow-forward" onPress={() => advance(3)} />
        </>
      ) : null}

      {step === 3 ? (
        <>
          <Card style={studyStyles.card}>
            <Ionicons name="checkmark-circle-outline" size={36} color={colors.primary} />
            <Text accessibilityRole="header" style={studyStyles.sectionTitle}>You’ve tried the learning loop.</Text>
            <Text style={studyStyles.body}>Build a daily plan around your MBBS, USMLE, or postgraduate entrance goals. Save answers, revisit mistakes, and connect available lessons to your own syllabus.</Text>
            <Text style={studyStyles.caption}>The current shared course is the draft Cardiovascular Foundations pilot. It is a limited sample, rather than complete exam or curriculum coverage.</Text>
            <Text style={studyStyles.caption}>This preview is separate from your saved study history.</Text>
            <Button
              label={session ? 'Open my study plan' : 'Create my study account'}
              icon="arrow-forward" onPress={() => router.replace(session ? '/today' : '/sign-up')}
            />
            {!session ? <Button label="I already have an account" variant="secondary" onPress={() => router.replace('/sign-in')} /> : null}
          </Card>
          <Button label="Try the preview again" variant="ghost" onPress={restart} />
        </>
      ) : null}
      <ReviewNote note="Original draft sample, with the reference linked above. Editorial review is pending." />
      {step < 3 ? <Button label="Leave preview" variant="ghost" onPress={() => router.replace(session ? '/today' : '/sign-in')} /> : null}
    </StudyPage>
  );
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', gap: 8 },
  step: { flex: 1, alignItems: 'center', gap: 7 },
  dot: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  dotActive: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '0C') },
  dotLabel: { color: colors.textMuted, fontWeight: '700' },
  stepLabel: { color: colors.textMuted, fontSize: 11, textAlign: 'center' },
  route: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', paddingVertical: 10 },
  routeItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  routeLabel: { color: colors.primary, fontSize: 12, fontWeight: '600', padding: 8, borderRadius: 8, backgroundColor: withAlpha(colors.primary, '0C') },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 60 },
  optionLetter: { color: colors.textMuted, fontWeight: '700' },
  optionText: { flex: 1 },
  selected: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '0C') },
  confidences: { flexDirection: 'row', gap: 8 },
  confidence: { flex: 1, padding: 10, minHeight: 56, borderWidth: 1, borderColor: colors.border, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  pressed: { opacity: 0.8 },
  correct: { borderColor: '#285E46', backgroundColor: '#122A29' },
  repair: { borderColor: '#5D5030', backgroundColor: '#28281F' },
});
