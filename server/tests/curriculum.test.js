import assert from 'node:assert/strict';
import test from 'node:test';
import { mappingInput, parseSyllabus, preferenceInput, suggestConcepts } from '../src/curriculum.js';
import { reportInput, validatePublishingMetadata } from '../src/content-review.js';
import { emptyProgress, planSession } from '../src/study-planner.js';
import { fixturePack } from './study-fixture.js';

test('syllabus import normalizes bullets, deduplicates, and rejects oversize content without truncation', () => {
  assert.deepEqual(parseSyllabus('- Cardiac cycle\n2. Renal filtration\ncardiac cycle\n'), ['Cardiac cycle', 'Renal filtration']);
  assert.throws(() => parseSyllabus(' '));
  assert.throws(() => parseSyllabus('-\n*\n1.\n2.'), /at least one/);
  assert.throws(() => parseSyllabus('x'.repeat(201)), /200/);
  assert.throws(() => parseSyllabus(Array.from({ length: 101 }, (_, i) => `Objective ${i}`).join('\n')), /100/);
});
test('track input is bounded, rejects unsupported tracks, and preserves optional empty fields', () => {
  for (const track of ['mbbs', 'usmle', 'postgraduate']) assert.deepEqual(preferenceInput({ track, goal: '  Finals  ', syllabus_text: '' }), { track, goal: 'Finals', syllabus_text: null });
  for (const input of [{ track: 'clinical' }, { track: 'mbbs', goal: 'x'.repeat(161) }, { track: 'mbbs', user_id: 'foreign' }, []]) assert.throws(() => preferenceInput(input));
});
test('word suggestions remain suggestions and cannot invent concept identities', () => {
  const concepts = [{ course_id: 'course', concept_id: 'flow', concept_title: 'Blood flow', objective: 'Trace circulation' }];
  assert.equal(suggestConcepts('Describe blood flow', concepts)[0].concept_id, 'flow');
  assert.deepEqual(suggestConcepts('Renal filtration', concepts), []);
  assert.deepEqual(mappingInput({ links: [{ course_id: 'course', concept_id: 'flow' }, { course_id: 'course', concept_id: 'flow' }] }, concepts), [{ course_id: 'course', concept_id: 'flow' }]);
  assert.throws(() => mappingInput({ links: [{ course_id: 'course', concept_id: 'invented' }] }, concepts));
  assert.throws(() => mappingInput({ links: [{ course_id: 'course', concept_id: 'flow', correct_index: 1 }] }, concepts));
});
test('confirmed syllabus objectives influence new learning while repair remains first', () => {
  const first = planSession(fixturePack, {}, 10, new Date('2026-10-07'), { syllabusConceptIds: ['cycle'] });
  assert.equal(first[0].concept_id, 'cycle');
  const repair = { flow: { ...emptyProgress(), lesson_completed: true, needs_repair: true } };
  assert.equal(planSession(fixturePack, repair, 20, new Date('2026-10-07'), { syllabusConceptIds: ['cycle'] })[0].concept_id, 'flow');
});
test('reviewed publishing requires real reviewer metadata and content provenance', () => {
  const pack = { ...fixturePack, rights: { commercial_distribution: 'original_content' } };
  assert.equal(validatePublishingMetadata(pack), pack);
  assert.throws(() => validatePublishingMetadata({ ...pack, review_status: 'reviewed' }), /reviewer/);
  assert.throws(() => validatePublishingMetadata({ ...pack, review_status: 'reviewed', reviewed_by: 'Reviewer', reviewed_at: '2026-02-30' }), /date/);
  assert.throws(() => validatePublishingMetadata({ ...pack, rights: {} }), /provenance/);
  assert.equal(validatePublishingMetadata({ ...pack, review_status: 'reviewed', reviewed_by: 'Reviewer', reviewed_at: '2026-01-01' }).review_status, 'reviewed');
});
test('content reports validate locations and reject foreign question or grading fields', () => {
  const input = { course_id: fixturePack.id, concept_id: 'flow', category: 'accuracy', message: 'Please verify this explanation.' };
  assert.equal(reportInput(input, fixturePack).question_id, null);
  assert.throws(() => reportInput({ ...input, question_id: 'cycle-q0' }, fixturePack));
  assert.throws(() => reportInput({ ...input, correct_index: 1 }, fixturePack));
  assert.throws(() => reportInput({ ...input, message: 'short' }, fixturePack));
});
