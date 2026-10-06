import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anchorForRatio, anchorForVisibleCells, isScrollTargetAligned, ratioAfterScroll, ratioForAnchor,
} from '../src/hooks/readerPosition.ts';

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

test('resume corrects early compact row estimates after mobile text wraps', () => {
  const saved = 0.73449296;
  const early = anchorForRatio(saved, 180, 738, 26);
  const wrapped = anchorForRatio(saved, 180, 738, 197);
  assert.equal(early.index, 111);
  assert.equal(wrapped.index, 129);
  assert.ok(Math.abs(ratioForAnchor(wrapped, 180, 738, 197) - saved) < 0.000001);
  assert.equal(ratioAfterScroll(saved, ratioForAnchor(early, 180, 738, 197)), saved);
});

test('chapter endpoints and empty/invalid input are bounded', () => {
  assert.deepEqual(anchorForRatio(0, 180, 600, 200), { index: 0, fraction: 0 });
  assert.equal(ratioForAnchor({ index: 177, fraction: 0 }, 180, 600, 200), 1);
  assert.deepEqual(anchorForRatio(0.6, 0, 600, 200), { index: 0, fraction: 0 });
  assert.equal(ratioAfterScroll(null, Number.NaN), 0);
});

test('actual mounted row rectangles determine progress despite stale virtualized frame indices', () => {
  const anchor = anchorForVisibleCells([
    { index: 75, top: -10_000, height: 197 }, // stale cached first-visible row
    { index: 130, top: 237, height: 197 },
    { index: 0, top: -25_000, height: 197 }, // retained initial render window
    { index: 129, top: 40, height: 197 },
    { index: 131, top: 434, height: 197 },
  ], 100, 738);
  assert.deepEqual(anchor, { index: 129, fraction: 60 / 197 });
  assert.ok(ratioForAnchor(anchor, 180, 738, 197) > 0.73);
  assert.equal(anchorForVisibleCells([{ index: 0, top: -197, height: 197 }], 0, 738), null);
});

test('requesting the same target again remains necessary while the temporary tail clamps scrolling', () => {
  const desired = 13_771.8;
  const clamped = 14_045 - 663;
  assert.equal(isScrollTargetAligned(desired, clamped, clamped, false), false);
  // The original target is unchanged, but the next render window permits it.
  assert.equal(isScrollTargetAligned(desired, desired, 15_329 - 663, false), true);
});

test('last-paragraph jumps accept the actual document end, while a temporary measured tail retries', () => {
  assert.equal(isScrollTargetAligned(35_300, 34_722, 34_722, true), true);
  assert.equal(isScrollTargetAligned(35_300, 34_722, 34_722, false), false);
  assert.equal(isScrollTargetAligned(20_000, 19_000, 34_722, true), false);
});
