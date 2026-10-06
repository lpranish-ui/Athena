import { excerptContext } from './context.js';

const STOP_WORDS = new Set(('a an and are as at be by can describe did do does explain for from give had has have how i in is it its list me of on or please tell that the their them there these they this to us was were what when where which who why will with would you your book chapter about').split(' '));

export function searchTerms(question) {
  return [...new Set(String(question).toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)).slice(0, 20);
}

/** Select the densest matching passage, with rarer query terms weighted higher. */
export function relevantExcerpt(row, terms, maxChars = 6000) {
  const content = String(row.content ?? '');
  if (!content || !terms.length) return null;
  const lower = content.toLowerCase();
  const occurrences = [];
  for (const term of terms) {
    const matches = [];
    const expression = new RegExp(`\\b${term}\\w*\\b`, 'g');
    for (const match of lower.matchAll(expression)) {
      matches.push(match.index);
      if (matches.length >= 200) break;
    }
    const weight = 1 / Math.max(1, Math.sqrt(matches.length));
    for (const at of matches) occurrences.push({ at, term, weight });
  }
  if (!occurrences.length) return null;
  occurrences.sort((a, b) => a.at - b.at);
  const candidates = [...new Set(occurrences.map((match) => Math.max(0, Math.min(
    content.length - maxChars, match.at - Math.floor(maxChars / 3),
  ))))].sort((a, b) => a - b);
  let bestStart = 0;
  let bestScore = -1;
  let left = 0;
  let right = 0;
  let distinctWeight = 0;
  const inWindow = new Map();
  for (const start of candidates) {
    while (right < occurrences.length && occurrences[right].at < start + maxChars) {
      const match = occurrences[right++];
      if (!inWindow.has(match.term)) distinctWeight += match.weight;
      inWindow.set(match.term, (inWindow.get(match.term) ?? 0) + 1);
    }
    while (left < right && occurrences[left].at < start) {
      const match = occurrences[left++];
      const remaining = inWindow.get(match.term) - 1;
      if (remaining === 0) { inWindow.delete(match.term); distinctWeight -= match.weight; }
      else inWindow.set(match.term, remaining);
    }
    // Repeated generic words cannot outrank a passage containing the specific
    // terms in the question. The sliding window keeps this linear after sort.
    const score = distinctWeight * 100 + Math.min(right - left, 5);
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  const excerpt = excerptContext(row, bestStart, maxChars);
  return { ...row, ...excerpt, segments: [excerpt] };
}
