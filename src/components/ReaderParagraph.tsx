import { memo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

export const ReaderParagraph = memo(function ReaderParagraph({
  text, index, color, tint, noted, fontFamily, fontSize, lineHeight, onLongPress,
}: {
  text: string;
  index: number;
  color: string;
  tint?: string;
  noted: boolean;
  fontFamily?: string;
  fontSize: number;
  lineHeight: number;
  onLongPress: (index: number, text: string) => void;
}) {
  return (
    <Pressable
      accessibilityLabel={noted ? `${text}. Has a saved note.` : text}
      accessibilityHint="Long press to highlight or add a note"
      onLongPress={() => onLongPress(index, text)}
      delayLongPress={350}
      style={tint ? [styles.highlight, { backgroundColor: tint }] : undefined}
    >
      <Text style={{ color, fontFamily, fontSize, lineHeight, marginBottom: Math.round(lineHeight * 0.55) }}>
        {text}{noted ? '  📝' : ''}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  highlight: {
    borderRadius: 8,
    paddingHorizontal: 8,
    marginHorizontal: -8,
    paddingTop: 4,
    marginTop: -4,
  },
});
