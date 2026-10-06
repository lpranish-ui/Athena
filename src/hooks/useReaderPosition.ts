import { useCallback, useEffect, useRef } from 'react';
import type {
    FlatList, LayoutChangeEvent, LayoutRectangle, NativeScrollEvent, NativeSyntheticEvent, ViewToken,
} from 'react-native';
import { Platform } from 'react-native';

import { saveReadingProgress } from '@/lib/api';
import {
    anchorForRatio, anchorForVisibleCells, isScrollTargetAligned,
    ratioAfterScroll, ratioForAnchor, type ParagraphAnchor,
} from './readerPosition';

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
  const contentHeightRef = useRef(0);
  const offsetRef = useRef(0);
  const firstVisibleRef = useRef(0);
  const lastVisibleRef = useRef(-1);
  const cellsRef = useRef(new Map<number, LayoutRectangle>());
  const measuredHeightRef = useRef(0);
  const averageHeightRef = useRef(0);
  const positioningDeadlineRef = useRef(0);
  const lastSaveRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const cancelSettle = useCallback(() => {
    clearRetry();
    positioningDeadlineRef.current = 0;
  }, [clearRetry]);

  const cancelParagraphJump = useCallback(() => {
    clearRetry();
    if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
    finishTimerRef.current = null;
    pendingParagraphRef.current = null;
    pendingParagraphChapterRef.current = null;
    positioningDeadlineRef.current = 0;
  }, [clearRetry]);

  const resetMetrics = useCallback(() => {
    cellsRef.current.clear();
    measuredHeightRef.current = 0;
    averageHeightRef.current = 0;
    firstVisibleRef.current = 0;
    lastVisibleRef.current = -1;
    contentHeightRef.current = 0;
    offsetRef.current = 0;
    positioningDeadlineRef.current = 0;
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
    let anchor: ParagraphAnchor;
    const scroller = webScroller();
    if (scroller) {
      const viewport = scroller.getBoundingClientRect();
      const cells = Array.from(scroller.querySelectorAll<HTMLElement>('[data-reader-index]'), (element) => {
        const rect = element.getBoundingClientRect();
        return { index: Number(element.dataset.readerIndex), top: rect.top, height: rect.height };
      });
      const visibleAnchor = anchorForVisibleCells(cells, viewport.top, viewport.height);
      if (!visibleAnchor) return;
      anchor = visibleAnchor;
      firstVisibleRef.current = anchor.index;
      offsetRef.current = scroller.scrollTop;
    } else {
      const index = firstVisibleRef.current;
      const cell = currentCellLayout(index);
      const fraction = cell && cell.height > 0
        ? Math.min(1, Math.max(0, (offsetRef.current - cell.y) / cell.height)) : 0;
      anchor = { index, fraction };
    }
    const observed = ratioForAnchor(anchor, paragraphCountRef.current,
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
    }
    if (anchor.index < 0 || anchor.index >= paragraphCountRef.current) {
      if (isPassage) cancelParagraphJump();
      return;
    }
    if (positioningDeadlineRef.current === 0) positioningDeadlineRef.current = Date.now() + 30_000;
    const scheduleRetry = () => {
      if (retryTimerRef.current !== null || Date.now() >= positioningDeadlineRef.current) return;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        position();
      }, 120);
    };
    const cell = currentCellLayout(anchor.index);
    if (cell) {
      const offset = Math.max(0, cell.y + anchor.fraction * cell.height - (isPassage ? 16 : 0));
      const scroller = webScroller();
      const actualOffset = scroller?.scrollTop ?? offsetRef.current;
      const endCell = scroller?.querySelector<HTMLElement>(`[data-reader-index="${paragraphCountRef.current - 1}"]`);
      const chapterEndMounted = scroller
        ? !!endCell && endCell.getBoundingClientRect().height > 0
        : lastVisibleRef.current === paragraphCountRef.current - 1;
      const maximumOffset = scroller
        ? scroller.scrollHeight - scroller.clientHeight
        : contentHeightRef.current - layoutHeightRef.current;
      if (!isScrollTargetAligned(offset, actualOffset, maximumOffset, chapterEndMounted)) {
        scrollRef.current.scrollToOffset({ offset, animated: false });
      }
      clearRetry();
      const aligned = isScrollTargetAligned(offset, scroller?.scrollTop ?? offsetRef.current,
        maximumOffset, chapterEndMounted);
      if (!aligned) {
        // A target near the measured tail may exist before there is enough
        // trailing content to put it at the top. Keep applying the same target
        // when later render windows enlarge the scrollable range.
        if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
        finishTimerRef.current = null;
        scheduleRetry();
      }
      if (isPassage && aligned && finishTimerRef.current === null) {
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
    if (retryTimerRef.current !== null || Date.now() >= positioningDeadlineRef.current) return;
    // The list's cached frame estimates can themselves be stale after text
    // wraps. Our measured average drives the next render window forward.
    scrollRef.current.scrollToOffset({
      offset: Math.max(0, averageHeightRef.current * (anchor.index + anchor.fraction) - (isPassage ? 16 : 0)),
      animated: false,
    });
    scheduleRetry();
  }, [cancelParagraphJump, clearRetry, currentCellLayout, webScroller]);

  const tryJumpToParagraph = useCallback(() => {
    if (pendingParagraphRef.current !== null &&
      pendingParagraphChapterRef.current === chapterIdRef.current) {
      pendingScrollRef.current = null;
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
    contentHeightRef.current = event.nativeEvent.contentSize.height;
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
    if (indices.length) {
      firstVisibleRef.current = Math.min(...indices);
      lastVisibleRef.current = Math.max(...indices);
    }
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
      return;
    }
    const prior = cellsRef.current.get(index);
    cellsRef.current.set(index, layout);
    measuredHeightRef.current += layout.height - (prior?.height ?? 0);
    averageHeightRef.current = measuredHeightRef.current / Math.max(1, cellsRef.current.size);
    tryPosition();
  }, [tryPosition]);

  const handleContentSize = useCallback((_width: number, height: number) => {
    contentHeightRef.current = height;
    tryPosition();
  }, [tryPosition]);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    layoutHeightRef.current = event.nativeEvent.layout.height;
    tryPosition();
  }, [tryPosition]);

  useEffect(() => () => {
    clearRetry();
    if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
    flushProgress();
  }, [clearRetry, flushProgress]);

  return {
    scrollRef, pendingScrollRef, pendingParagraphRef, pendingParagraphChapterRef,
    paragraphCountRef, ratioRef, chapterIdRef, cancelSettle, cancelParagraphJump,
    resetMetrics, flushProgress, tryJumpToParagraph, handleScroll, handleContentSize,
    handleLayout, handleUserScroll, handleCellLayout,    firstVisibleRef,    handleViewableItemsChanged: stableViewabilityCallbackRef.current,
  };
}
