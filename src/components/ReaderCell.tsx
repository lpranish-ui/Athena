import type { CellRendererProps } from '@react-native/virtualized-lists';
import { createContext, useContext } from 'react';
import { View, type LayoutRectangle } from 'react-native';

export const ReaderCellLayoutContext = createContext<(index: number, layout: LayoutRectangle) => void>(
  () => {},
);

/** Report real cell offsets without replacing the list's own measurement. */
export function ReaderCell({ index, style, onLayout, onFocusCapture, children }: CellRendererProps<string>) {
  const recordLayout = useContext(ReaderCellLayoutContext);
  return (
    <View
      style={style}
      {...{ onFocusCapture, dataSet: { readerIndex: String(index) } }}
      onLayout={(event) => {
        onLayout?.(event);
        recordLayout(index, event.nativeEvent.layout);
      }}
    >
      {children}
    </View>
  );
}
