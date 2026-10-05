// Athena wordmark.

import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/theme';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <View style={styles.row}>
      <View style={[styles.mark, compact && styles.markCompact]}>
        <Ionicons name="pulse" size={compact ? 18 : 24} color={colors.primaryText} />
      </View>
      <Text style={[styles.name, compact && styles.nameCompact]}>Athena</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
  },
  mark: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    padding: 11,
  },
  markCompact: {
    borderRadius: 10,
    padding: 7,
  },
  name: {
    color: colors.text,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  nameCompact: {
    fontSize: 22,
  },
});
