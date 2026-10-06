import { View } from 'react-native';

import { Button, ErrorBanner } from '@/components/ui';

/** Keep failed requests distinct from a successfully loaded empty collection. */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={{ gap: 16, paddingVertical: 24 }}>
      <ErrorBanner message={message} />
      <Button label="Try again" icon="refresh-outline" onPress={onRetry} />
    </View>
  );
}
