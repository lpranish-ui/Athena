import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Input } from '@/components/ui';
import { getStudyTrack, MAX_STUDY_GOAL_LENGTH, STUDY_TRACKS, type StudyTrack } from '@/lib/tracks';
import { colors, withAlpha } from '@/theme';
import { studyStyles } from './StudyUI';

export function StudyTrackPicker({ track, goal, onTrackChange, onGoalChange, disabled = false }: {
  track: StudyTrack;
  goal: string;
  onTrackChange: (track: StudyTrack) => void;
  onGoalChange: (goal: string) => void;
  disabled?: boolean;
}) {
  const selected = getStudyTrack(track);
  return (
    <View style={studyStyles.gap}>
      <View accessibilityRole="radiogroup" accessibilityLabel="Study track" style={styles.tracks}>
        {STUDY_TRACKS.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="radio"
            accessibilityLabel={`${item.title}. ${item.description}`}
            accessibilityState={{ checked: track === item.id, disabled }}
            aria-checked={track === item.id}
            disabled={disabled}
            onPress={() => {
              if (track !== item.id) {
                onTrackChange(item.id);
                onGoalChange('');
              }
            }}
            style={({ pressed }) => [styles.track, track === item.id && styles.selected, pressed && styles.pressed]}
          >
            <Text style={[studyStyles.label, track === item.id && { color: colors.primary }]}>{item.title}</Text>
            <Text style={studyStyles.caption}>{item.description}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={studyStyles.label}>What would you like to work toward?</Text>
      <View style={styles.goals}>
        {selected.goals.map((suggestion) => (
          <Pressable
            key={suggestion}
            accessibilityRole="button"
            accessibilityState={{ selected: goal === suggestion, disabled }}
            disabled={disabled}
            onPress={() => onGoalChange(suggestion)}
            style={({ pressed }) => [styles.goal, goal === suggestion && styles.selected, pressed && styles.pressed]}
          >
            <Text style={[studyStyles.caption, goal === suggestion && { color: colors.primary }]}>{suggestion}</Text>
          </Pressable>
        ))}
      </View>
      <Input
        label="Your goal (optional)"
        accessibilityLabel="Your study goal, optional"
        value={goal}
        onChangeText={onGoalChange}
        placeholder="Choose a suggestion or write your own goal"
        maxLength={MAX_STUDY_GOAL_LENGTH}
        editable={!disabled}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tracks: { gap: 10 },
  track: { gap: 5, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surfaceAlt, minHeight: 76 },
  selected: { borderColor: colors.primary, backgroundColor: withAlpha(colors.primary, '0C') },
  goals: { gap: 8 },
  goal: { padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 48, justifyContent: 'center' },
  pressed: { opacity: 0.8 },
});
