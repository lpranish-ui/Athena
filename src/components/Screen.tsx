// Full-screen container with safe areas and a comfortable max width on web.

import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { colors } from '@/theme';

export function Screen({
  children,
  style,
  padded = true,
  edges = ['top', 'left', 'right'],
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  edges?: Edge[];
}) {
  return (
    <SafeAreaView style={[styles.screen, padded && styles.padded, style]} edges={edges}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
  },
  padded: {
    paddingHorizontal: 20,
  },
});
