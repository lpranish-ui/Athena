export interface ParagraphAnchor {
  index: number;
  fraction: number;
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
