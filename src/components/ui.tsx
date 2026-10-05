// Small shared UI primitives used across Athena's screens.

import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    View,
    type StyleProp,
    type TextInputProps,
    type ViewStyle,
} from 'react-native';

import { colors, fontSize, radius, spacing, withAlpha } from '@/theme';

export type IoniconName = ComponentProps<typeof Ionicons>['name'];

// ── Button ───────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  icon?: IoniconName;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  small = false,
  icon,
  style,
}: ButtonProps) {
  const inactive = disabled || loading;
  const textColor =
    variant === 'primary'
      ? colors.primaryText
      : variant === 'danger'
        ? colors.white
        : variant === 'ghost'
          ? colors.primary
          : colors.text;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        variant === 'ghost' && styles.buttonGhost,
        inactive && styles.buttonInactive,
        pressed && !inactive && styles.buttonPressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 15 : 17} color={textColor} /> : null}
          <Text style={[styles.buttonLabel, small && styles.buttonLabelSmall, { color: textColor }]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function Card({
  children,
  style,
  padded = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}) {
  return <View style={[styles.card, padded && styles.cardPadded, style]}>{children}</View>;
}

// ── Badge ────────────────────────────────────────────────────────────────────

export function Badge({
  label,
  color = colors.primary,
  style,
}: {
  label: string;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: withAlpha(color, '22'), borderColor: withAlpha(color, '66') },
        style,
      ]}
    >
      <Text style={[styles.badgeLabel, { color }]}>{label}</Text>
    </View>
  );
}

// ── Error banner ─────────────────────────────────────────────────────────────

export function ErrorBanner({
  message,
  style,
}: {
  message: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.errorBanner, style]}>
      <Ionicons name="alert-circle" size={18} color={colors.danger} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

export function EmptyState({
  icon = 'sparkles-outline',
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon?: IoniconName;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={26} color={colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.emptyMessage}>{message}</Text> : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} small style={styles.emptyAction} />
      ) : null}
    </View>
  );
}

// ── Full-screen loading ──────────────────────────────────────────────────────

export function LoadingView({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.loadingLabel}>{label}</Text>
    </View>
  );
}

// ── Text input ───────────────────────────────────────────────────────────────

interface InputProps extends TextInputProps {
  label?: string;
}

export function Input({ label, style, ...rest }: InputProps) {
  return (
    <View style={styles.inputWrap}>
      {label ? <Text style={styles.inputLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textMuted}
        style={[styles.input, rest.multiline && styles.inputMultiline, style]}
        {...rest}
      />
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 13,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    minHeight: 46,
  },
  buttonSmall: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 36,
  },
  buttonPrimary: {
    backgroundColor: colors.primary,
  },
  buttonSecondary: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDanger: {
    backgroundColor: '#B91C1C',
  },
  buttonGhost: {
    backgroundColor: 'transparent',
  },
  buttonInactive: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonLabel: {
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  buttonLabelSmall: {
    fontSize: fontSize.sm,
  },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
  },
  cardPadded: {
    padding: spacing.md,
  },

  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.dangerSurface,
    borderWidth: 1,
    borderColor: withAlpha(colors.danger, '55'),
    borderRadius: radius.md,
    padding: 12,
  },
  errorText: {
    flex: 1,
    color: colors.dangerText,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },

  empty: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: withAlpha(colors.primary, '1A'),
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
  },
  emptyMessage: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 420,
  },
  emptyAction: {
    marginTop: spacing.sm,
  },

  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: colors.background,
  },
  loadingLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },

  inputWrap: {
    gap: 6,
  },
  inputLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: colors.text,
    fontSize: fontSize.md,
  },
  inputMultiline: {
    minHeight: 160,
    textAlignVertical: 'top',
    paddingTop: 12,
  },
});
