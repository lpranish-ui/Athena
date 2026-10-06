// Cloze (fill-in-the-blank) answer checking. Grading is forgiving about
// case, filler articles and punctuation, plus a little typo tolerance — but
// an empty or invented answer never passes.

export function normalizeClozeAnswer(value: string): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, index) => index);
  for (let i = 1; i < rows; i++) {
    const current = [i];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}

/** Tolerant check for a typed cloze answer against the expected term. */
export function isClozeCorrect(given: string, expected: string): boolean {
  const a = normalizeClozeAnswer(given);
  const b = normalizeClozeAnswer(expected);
  if (!a || !b) return false;
  if (a === b) return true;
  // Accept a short answer that wraps the term ("roughly 60 to 100").
  if (b.length >= 4 && a.includes(b) && a.length <= b.length + 12) return true;
  // Typo tolerance: a small edit distance for longer terms.
  if (a.length >= 5 && Math.abs(a.length - b.length) <= 2) {
    return levenshtein(a, b) <= (b.length >= 8 ? 2 : 1);
  }
  return false;
}
