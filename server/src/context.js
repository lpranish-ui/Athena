// Bounded excerpts retain their original page boundaries and quote provenance.
import { validMarks, withPageMarkers } from './questions.js';

const GAP = '\n\n[Excerpt gap: source text omitted]\n\n';

export function excerptContext(row, start, length) {
  const full = String(row.content ?? '');
  const from = Math.max(0, Math.min(full.length, Math.floor(start)));
  const to = Math.min(full.length, from + Math.max(0, Math.floor(length)));
  const marks = validMarks(row.pageMap ?? row.page_map).filter((mark) => mark.char_start < full.length);
  const active = marks.filter((mark) => mark.char_start <= from).at(-1);
  const pageMap = [];
  if (active && to > from) pageMap.push({ page: active.page, char_start: 0 });
  for (const mark of marks) {
    if (mark.char_start > from && mark.char_start < to) {
      pageMap.push({ page: mark.page, char_start: mark.char_start - from });
    }
  }
  return { content: full.slice(from, to), pageMap, sourceStart: from, sourceEnd: to };
}

/** Evenly sample the chapter, rotating interior windows for later quiz batches. */
export function sampleChapterContext(row, maxChars = 16000, { phase = 0 } = {}) {
  const content = String(row.content ?? '');
  const budget = Math.max(1, Math.floor(maxChars));
  const count = content.length <= budget ? 1 : Math.min(4, Math.max(1, Math.floor(budget / 1000)));
  const windowSize = Math.max(1, Math.floor((budget - GAP.length * (count - 1)) / count));
  const rotation = ((Number(phase) || 0) * 0.61803398875) % 1;
  const segments = [];
  for (let index = 0; index < count; index++) {
    let start;
    let length;
    if (count === 1) {
      start = 0;
      length = Math.min(content.length, budget);
    } else {
      const bandStart = Math.floor(index * content.length / count);
      const bandEnd = Math.floor((index + 1) * content.length / count);
      const room = Math.max(0, bandEnd - bandStart - windowSize);
      start = index === 0 ? 0 : index === count - 1
        ? content.length - windowSize
        : bandStart + Math.floor(room * ((0.5 + rotation) % 1));
      length = windowSize;
      // Avoid starting/ending a snippet in the middle of a word. Shrinking
      // rather than expanding keeps the prompt within its assigned budget.
      if (start > 0 && /\S/.test(content[start - 1] ?? '') && /\S/.test(content[start] ?? '')) {
        const offset = content.slice(start, start + Math.min(80, length)).search(/\s/);
        if (offset >= 0) { start += offset + 1; length -= offset + 1; }
      }
      const end = start + length;
      if (end < content.length && /\S/.test(content[end - 1] ?? '') && /\S/.test(content[end] ?? '')) {
        const tail = content.slice(Math.max(start, end - 80), end);
        const boundary = tail.search(/\s\S*$/);
        if (boundary >= 0) length -= tail.length - boundary;
      }
    }
    const segment = excerptContext(row, start, length);
    if (segment.content) segments.push(segment);
  }

  let combined = '';
  const pageMap = [];
  for (const segment of segments) {
    if (combined) combined += GAP;
    const offset = combined.length;
    pageMap.push(...segment.pageMap.map((mark) => ({ ...mark, char_start: offset + mark.char_start })));
    combined += segment.content;
  }
  return {
    id: row.id,
    title: row.title,
    content: combined,
    pageMap,
    segments,
    sampled: content.length > budget,
    firstPage: pageMap[0]?.page ?? null,
    lastPage: pageMap.at(-1)?.page ?? null,
  };
}

export function contextWithPageMarkers(context) {
  if (!Array.isArray(context.segments)) return withPageMarkers(context.content, context.pageMap);
  return context.segments.map((segment) => withPageMarkers(segment.content, segment.pageMap)).join(GAP);
}
