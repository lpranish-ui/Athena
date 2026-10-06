import assert from 'node:assert/strict';
import test from 'node:test';

import { anchorForRatio, ratioAfterScroll, ratioForAnchor } from '../src/hooks/readerPosition.ts';

test('60% resume targets the full 180-paragraph chapter, not its initial render window', () => {
  const anchor = anchorForRatio(0.6, 180, 600, 200);
  assert.equal(anchor.index, 106);
  assert.ok(Math.abs(anchor.fraction - 0.2) < 0.000001);
  assert.ok(Math.abs(ratioForAnchor(anchor, 180, 600, 200) - 0.6) < 0.000001);
});

test('paragraph 100 progress uses the full chapter even when only 120 rows are measured', () => {
  const ratio = ratioForAnchor({ index: 100, fraction: 0.5 }, 180, 600, 200);
  assert.ok(Math.abs(ratio - 100.5 / 177) < 0.000001);
  assert.ok(ratio < 0.6);
});

test('resume and no-scroll exit preserve the saved ratio through late layout scroll events', () => {
  assert.equal(ratioAfterScroll(0.6, 0.45), 0.6);
  assert.equal(ratioAfterScroll(0.6, 1), 0.6);
  assert.equal(ratioAfterScroll(null, 0.45), 0.45);
});

test('chapter endpoints and empty/invalid input are bounded', () => {
  assert.deepEqual(anchorForRatio(0, 180, 600, 200), { index: 0, fraction: 0 });
  assert.equal(ratioForAnchor({ index: 177, fraction: 0 }, 180, 600, 200), 1);
  assert.deepEqual(anchorForRatio(0.6, 0, 600, 200), { index: 0, fraction: 0 });
  assert.equal(ratioAfterScroll(null, Number.NaN), 0);
});
