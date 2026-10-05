// Card used in the library grid to represent one book.

import { Ionicons } from '@expo/vector-icons';
import {
    Pressable,
    StyleSheet,
    Text,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { initials } from '@/lib/format';
import { colors, fontSize, getSubjectColor, radius, spacing, withAlpha } from '@/theme';
import type { BookWithCounts } from '@/types';

export function BookCard({
  book,
  onPress,
  style,
}: {
  book: BookWithCounts;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const cover = book.cover_color ?? getSubjectColor(book.subject);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
    >
      <View style={[styles.cover, { backgroundColor: cover }]}>
        <Text style={styles.coverInitials}>{initials(book.title)}</Text>
        {book.status !== 'ready' ? (
          <View style={styles.statusOverlay}>
            <Ionicons
              name={book.status === 'processing' ? 'time-outline' : 'alert-circle-outline'}
              size={13}
              color={colors.white}
            />
            <Text style={styles.statusText}>
              {book.status === 'processing' ? 'Processing' : 'Failed'}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={2}>
          {book.title}
        </Text>
        <Text style={styles.subject} numberOfLines={1}>
          {book.subject}
        </Text>

        <View style={styles.footer}>
          <View style={styles.meta}>
            <Ionicons name="list-outline" size={12} color={colors.textMuted} />
            <Text style={styles.metaText}>
              {book.chapter_count} {book.chapter_count === 1 ? 'chapter' : 'chapters'}
            </Text>
          </View>
          <View
            style={[
              styles.ownerChip,
              {
                backgroundColor: withAlpha(book.is_default ? colors.primary : colors.accent, '22'),
              },
            ]}
          >
            <Text
              style={[
                styles.ownerText,
                { color: book.is_default ? colors.primary : colors.accent },
              ]}
            >
              {book.is_default ? 'Built-in' : 'Mine'}
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  pressed: {
    opacity: 0.88,
  },
  cover: {
    height: 92,
    padding: spacing.md,
    justifyContent: 'flex-end',
  },
  coverInitials: {
    color: 'rgba(255, 255, 255, 0.92)',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 1,
  },
  statusOverlay: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  statusText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: '700',
  },
  body: {
    padding: 12,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  subject: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  ownerChip: {
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  ownerText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
