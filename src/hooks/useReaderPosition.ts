import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type {
  FlatList, LayoutChangeEvent, LayoutRectangle, NativeScrollEvent, NativeSyntheticEvent, ViewToken,
} from 'react-native';

import { saveReadingProgress } from '@/lib/api';
import { anchorForRatio, ratioAfterScroll, ratioForAnchor, type ParagraphAnchor } from './readerPosition';

/** Positions are based on the complete chapter, independent of the native render window. */
export function useReaderPosition(bookId: string) {
  const scrollRef = useRef<FlatList<string>>(null);
  const pendingScrollRef = useRef<number | null>(null);
  const pendingParagraphRef = useRef<number | null>(null);
  const pendingParagraphChapterRef = useRef<string | null>(null);
  const paragraphCountRef = useRef(0);
  const ratioRef = useRef(0);
  const chapterIdRef = useRef<string | null>(null);
  const layoutHeightRef = useRef(0);
  const offsetRef = useRef(0);
  const firstVisibleRef = useRef(0);
  const cellsRef = useRef(new Map<number, LayoutRectangle>());
  const measuredHeightRef = useRef(0);
  const averageHeightRef = useRef(0);
  const resumeAnchorRef = useRef<ParagraphAnchor | null>(null);
  const lastAppliedOffsetRef = useRef<number | null>(null);
  const lastSaveRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpAttemptsRef = useRef(0);
  const debugCountRef = useRef(0);
  const debugTargetRef = useRef<number | null>(null);
  const debugOffsetRef = useRef<number | null>(null);

  const debugPosition = useCallback((event: string, details: Record<string, unknown>) => {
    if (debugCountRef.current >= 50) return;
    debugCountRef.current += 1;
    console.info('ATHENA_READER_DEBUG', JSON.stringify({
      event,
      count: paragraphCountRef.current,
      viewportHeight: layoutHeightRef.current,
      averageHeight: averageHeightRef.current,
      validMeasurements: cellsRef.current.size,
      measuredHeight: measuredHeightRef.current,
      firstVisible: firstVisibleRef.current,
      scrollOffset: offsetRef.current,
      pendingRatio: pendingScrollRef.current,
      sampleHeights: [...cellsRef.current.entries()].slice(0, 6).map(([index, cell]) => [index, cell.height]),
      ...details,
    }));
  }, []);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const cancelSettle = useCallback(() => {
    clearRetry();
    resumeAnchorRef.current = null;
    lastAppliedOffsetRef.current = null;
    jumpAttemptsRef.current = 0;
  }, [clearRetry]);

  const cancelParagraphJump = useCallback(() => {
    clearRetry();
    if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
    finishTimerRef.current = null;
    pendingParagraphRef.current = null;
    pendingParagraphChapterRef.current = null;
    lastAppliedOffsetRef.current = null;
    jumpAttemptsRef.current = 0;
  }, [clearRetry]);

  const resetMetrics = useCallback(() => {
    cellsRef.current.clear();
    measuredHeightRef.current = 0;
    averageHeightRef.current = 0;
    firstVisibleRef.current = 0;
    offsetRef.current = 0;
    resumeAnchorRef.current = null;
    lastAppliedOffsetRef.current = null;
    jumpAttemptsRef.current = 0;
    clearRetry();
  }, [clearRetry]);

  const flushProgress = useCallback(() => {
    if (bookId && chapterIdRef.current) {
      void saveReadingProgress(bookId, chapterIdRef.current, ratioRef.current);
    }
  }, [bookId]);

  const webScroller = useCallback((): HTMLElement | null => {
    if (Platform.OS !== 'web') return null;
    const node = scrollRef.current?.getScrollableNode() as HTMLElement | undefined;
    return node && typeof node.querySelector === 'function' ? node : null;
  }, []);

  const currentCellLayout = useCallback((index: number): LayoutRectangle | undefined => {
    const scroller = webScroller();
    if (!scroller) return cellsRef.current.get(index);
    // ResizeObserver does not report a cell moving when a virtual spacer
    // changes. Read its current position rather than the old onLayout y.
    const element = scroller.querySelector<HTMLElement>(`[data-reader-index="${index}"]`);
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    if (rect.height <= 0) return undefined;
    return {
      x: rect.left - viewport.left + scroller.scrollLeft,
      y: rect.top - viewport.top + scroller.scrollTop,
      width: rect.width,
      height: rect.height,
    };
  }, [webScroller]);

  const updateObservedRatio = useCallback(() => {
    let index = firstVisibleRef.current;
    const scroller = webScroller();
    if (scroller) {
      const viewport = scroller.getBoundingClientRect();
      let firstVisible: number | null = null;
      for (const element of scroller.querySelectorAll<HTMLElement>('[data-reader-index]')) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
          const candidate = Number(element.dataset.readerIndex);
          if (Number.isInteger(candidate) && (firstVisible === null || candidate < firstVisible)) {
            firstVisible = candidate;
          }
        }
      }
      if (firstVisible !== null) index = firstVisible;
      firstVisibleRef.current = index;
      offsetRef.current = scroller.scrollTop;
    }
    const cell = currentCellLayout(index);
    const fraction = cell && cell.height > 0
      ? Math.min(1, Math.max(0, (offsetRef.current - cell.y) / cell.height)) : 0;
    const observed = ratioForAnchor({ index, fraction }, paragraphCountRef.current,
      layoutHeightRef.current, averageHeightRef.current);
    ratioRef.current = ratioAfterScroll(pendingScrollRef.current, observed);
  }, [currentCellLayout, webScroller]);

  const tryPosition = useCallback(function position() {
    if (!scrollRef.current || !paragraphCountRef.current || layoutHeightRef.current <= 0) return;
    const paragraph = pendingParagraphRef.current;
    const isPassage = paragraph !== null && pendingParagraphChapterRef.current === chapterIdRef.current;
    let anchor: ParagraphAnchor;
    if (isPassage) {
      anchor = { index: paragraph, fraction: 0 };
    } else {
      const saved = pendingScrollRef.current;
      if (saved === null) return;
      ratioRef.current = ratioAfterScroll(saved, ratioRef.current);
      // Wait for initial row heights instead of treating the initial native
      // contentSize (often just 30-45 paragraphs) as the whole chapter.
      if (averageHeightRef.current <= 0 || cellsRef.current.size < Math.min(6, paragraphCountRef.current)) return;
      // Text wrapping and the viewport can settle after the first layout. Keep
      // the saved ratio fixed, but recalculate its anchor from current metrics.
      anchor = anchorForRatio(saved, paragraphCountRef.current,
        layoutHeightRef.current, averageHeightRef.current);
      resumeAnchorRef.current = anchor;
    }
    if (anchor.index < 0 || anchor.index >= paragraphCountRef.current) {
      if (isPassage) cancelParagraphJump();
      return;
    }
    const cell = currentCellLayout(anchor.index);
    if (debugTargetRef.current !== anchor.index ||
      (cell && debugOffsetRef.current !== cell.y)) {
      debugTargetRef.current = anchor.index;
      debugOffsetRef.current = cell?.y ?? null;
      debugPosition('target', { anchor, cell, attempts: jumpAttemptsRef.current });
    }
    if (cell) {
      const offset = Math.max(0, cell.y + anchor.fraction * cell.height - (isPassage ? 16 : 0));
      if (lastAppliedOffsetRef.current === null || Math.abs(lastAppliedOffsetRef.current - offset) > 1) {
        lastAppliedOffsetRef.current = offset;
        scrollRef.current.scrollToOffset({ offset, animated: false });
      }
      clearRetry();
      if (isPassage && finishTimerRef.current === null) {
        ratioRef.current = ratioForAnchor(anchor, paragraphCountRef.current,
          layoutHeightRef.current, averageHeightRef.current);
        finishTimerRef.current = setTimeout(cancelParagraphJump, 800);
      }
      // Resume deliberately retains its saved ratio until a real user scroll,
      // even if late layout/spacer events produce additional native scrolls.
      return;
    }
    // Many cells can report layout in one batch; let one retry advance that
    // batch instead of consuming the retry limit for every individual row.
    if (retryTimerRef.current !== null || jumpAttemptsRef.current >= 60) return;
    jumpAttemptsRef.current += 1;
    // The list's cached frame estimates can themselves be stale after text
    // wraps. Our measured average drives the next render window forward.
    scrollRef.current.scrollToOffset({
      offset: Math.max(0, averageHeightRef.current * (anchor.index + anchor.fraction) - (isPassage ? 16 : 0)),
      animated: false,
    });
    clearRetry();
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      position();
    }, 120);
  }, [cancelParagraphJump, clearRetry, currentCellLayout, debugPosition]);

  const tryJumpToParagraph = useCallback(() => {
    if (pendingParagraphRef.current !== null &&
      pendingParagraphChapterRef.current === chapterIdRef.current) {
      pendingScrollRef.current = null;
      resumeAnchorRef.current = null;
      tryPosition();
    }
  }, [tryPosition]);

  const handleUserScroll = useCallback(() => {
    cancelSettle();
    cancelParagraphJump();
    pendingScrollRef.current = null;
    updateObservedRatio();
  }, [cancelParagraphJump, cancelSettle, updateObservedRatio]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetRef.current = event.nativeEvent.contentOffset.y;
    layoutHeightRef.current = event.nativeEvent.layoutMeasurement.height;
    updateObservedRatio();
    if (Date.now() - lastSaveRef.current > 2500) {
      lastSaveRef.current = Date.now();
      flushProgress();
    }
  }, [flushProgress, updateObservedRatio]);

  const handleViewableItemsChanged = useCallback((info: { viewableItems: ViewToken<string>[] }) => {
    const indices = info.viewableItems
      .filter((entry) => entry.isViewable && entry.index !== null)
      .map((entry) => entry.index as number);
    if (indices.length) firstVisibleRef.current = Math.min(...indices);
    updateObservedRatio();
  }, [updateObservedRatio]);

  // Fast Refresh can invalidate useCallback caches. FlatList requires this
  // particular prop to retain its identity for the entire mounted list.
  const latestViewabilityCallbackRef = useRef(handleViewableItemsChanged);
  useEffect(() => {
    latestViewabilityCallbackRef.current = handleViewableItemsChanged;
  }, [handleViewableItemsChanged]);
  const stableViewabilityCallbackRef = useRef((info: { viewableItems: ViewToken<string>[] }) => {
    latestViewabilityCallbackRef.current(info);
  });

  const handleCellLayout = useCallback((index: number, layout: LayoutRectangle) => {
    if (!Number.isFinite(layout.height) || layout.height <= 0) {
      debugPosition('skip-cell', { index, layout });
      return;
    }
    const prior = cellsRef.current.get(index);
    cellsRef.current.set(index, layout);
    measuredHeightRef.current += layout.height - (prior?.height ?? 0);
    averageHeightRef.current = measuredHeightRef.current / Math.max(1, cellsRef.current.size);
    if (cellsRef.current.size <= 6) debugPosition('cell', { index, layout });
    tryPosition();
  }, [debugPosition, tryPosition]);

  const handleContentSize = useCallback(() => tryPosition(), [tryPosition]);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    layoutHeightRef.current = event.nativeEvent.layout.height;
    tryPosition();
  }, [tryPosition]);

  const handleScrollToIndexFailed = useCallback((info: {
    index: number; averageItemLength: number; highestMeasuredFrameIndex: number;
  }) => {
    if (pendingScrollRef.current === null && pendingParagraphRef.current !== info.index) return;
    if (averageHeightRef.current <= 0) averageHeightRef.current = info.averageItemLength;
    // Moving to the current tail causes another bounded window to be measured;
    // retries advance toward the target until its real cell offset is available.
    scrollRef.current?.scrollToOffset({
      offset: Math.max(0, info.averageItemLength * info.index), animated: false,
    });
  }, []);

  useEffect(() => () => {
    clearRetry();
    if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
    flushProgress();
  }, [clearRetry, flushProgress]);

  return {
    scrollRef, pendingScrollRef, pendingParagraphRef, pendingParagraphChapterRef,
    paragraphCountRef, ratioRef, chapterIdRef, cancelSettle, cancelParagraphJump,
    resetMetrics, flushProgress, tryJumpToParagraph, handleScroll, handleContentSize,
    handleLayout, handleUserScroll, handleScrollToIndexFailed, handleCellLayout,
    handleViewableItemsChanged: stableViewabilityCallbackRef.current,
  };
}
