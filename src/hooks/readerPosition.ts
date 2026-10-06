export interface ParagraphAnchor {
  index: number;
  fraction: number;
}

export interface VisibleParagraphCell {
  index: number;
  top: number;
  height: number;
}

export function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function scrollableParagraphs(count: number, viewportHeight: number, averageHeight: number): number {
  const visible = averageHeight > 0 ? viewportHeight / averageHeight : 0;
  return Math.max(1, count - Math.max(0, visible));
}

/** Use all paragraphs, never the temporarily capped native content height. */
export function anchorForRatio(
  ratio: number, count: number, viewportHeight: number, averageHeight: number,
): ParagraphAnchor {
  if (count <= 0) return { index: 0, fraction: 0 };
  const position = clampRatio(ratio) * scrollableParagraphs(count, viewportHeight, averageHeight);
  const index = Math.min(count - 1, Math.floor(position));
  return { index, fraction: Math.min(1, Math.max(0, position - index)) };
}

export function ratioForAnchor(
  anchor: ParagraphAnchor, count: number, viewportHeight: number, averageHeight: number,
): number {
  if (count <= 0) return 0;
  return clampRatio((anchor.index + clampRatio(anchor.fraction)) /
    scrollableParagraphs(count, viewportHeight, averageHeight));
}

/** Layout/programmatic events must not change the saved value during resume. */
export function ratioAfterScroll(savedRatio: number | null, observedRatio: number): number {
  return clampRatio(savedRatio ?? observedRatio);
}

/** Find the actual visible row, even when virtualized frame positions are stale. */
export function anchorForVisibleCells(
  cells: VisibleParagraphCell[], viewportTop: number, viewportHeight: number,
): ParagraphAnchor | null {
  let first: VisibleParagraphCell | null = null;
  for (const cell of cells) {
    if (!Number.isInteger(cell.index) || cell.index < 0 || cell.height <= 0) continue;
    if (cell.top + cell.height <= viewportTop || cell.top >= viewportTop + viewportHeight) continue;
    if (first === null || cell.index < first.index) first = cell;
  }
  return first ? { index: first.index, fraction: clampRatio((viewportTop - first.top) / first.height) } : null;
}

/** A capped render window is temporary; only a mounted chapter end permits clamping. */
export function isScrollTargetAligned(
  desiredOffset: number, actualOffset: number, maximumOffset: number, chapterEndMounted: boolean,
): boolean {
  const reachableOffset = chapterEndMounted
    ? Math.min(desiredOffset, Math.max(0, maximumOffset)) : desiredOffset;
  return Math.abs(actualOffset - reachableOffset) <= 1;
}
