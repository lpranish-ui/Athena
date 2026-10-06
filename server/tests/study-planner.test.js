import assert from 'node:assert/strict';
import { test } from 'node:test';
import { courseDetail, emptyProgress, localDate, planSession, recordAnswer,
  requireToday, serializeSession, validateDate, validateTimezone } from '../src/study-planner.js';
import { fixturePack } from './study-fixture.js';
const now = new Date('2026-10-06T22:30:00.000Z');

test('calendar validation rejects normalized dates and timezone uses the enrollment day', () => {
  assert.equal(validateDate('2028-02-29'), '2028-02-29');
  for (const date of ['2026-02-29', '2026-04-31', '2026-10-6', 'garbage']) assert.throws(() => validateDate(date));
  assert.throws(() => validateTimezone('Mars/Olympus'));
  assert.equal(localDate(now, 'Asia/Kathmandu'), '2026-10-07');
  assert.equal(localDate(now, 'America/New_York'), '2026-10-06');
  assert.equal(requireToday(undefined, now, 'Asia/Kathmandu'), '2026-10-07');
  assert.throws(() => requireToday('2026-10-06', now, 'Asia/Kathmandu'), /today/);
});

test('every supported minute budget produces a bounded plan with an independent exit variant', () => {
  for (let minutes = 10; minutes <= 60; minutes++) {
    const steps = planSession(fixturePack, {}, minutes, now);
    assert.ok(steps.reduce((sum, step) => sum + step.estimated_minutes, 0) <= minutes);
    assert.equal(steps[0].type, 'lesson');
    assert.equal(steps.at(-1).kind, 'exit');
    const ids = steps.filter((step) => step.type === 'question').map((step) => step.question_snapshot.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('repair outranks due review and new learning, and rotates away from repeated questions', () => {
  const progress = {
    flow: { ...emptyProgress(), status: 'learning', lesson_completed: true, due_at: '2026-10-05T00:00:00Z' },
    preload: { ...emptyProgress(), needs_repair: true, status: 'needs_review', lesson_completed: true,
      question_attempts: { 'preload-q0': { count: 2, last_at: '2026-10-06T00:00:00Z' } } },
  };
  const steps = planSession(fixturePack, progress, 25, now);
  assert.equal(steps[0].concept_id, 'preload');
  assert.equal(steps[0].kind, 'repair');
  assert.equal(steps[1].question_snapshot.id, 'preload-q1');
  assert.ok(steps.some((step) => step.kind === 'review' && step.concept_id === 'flow'));
  assert.ok(steps.some((step) => step.kind === 'new'));
});

test('an approaching assessment makes room for uncovered objectives after the first due review', () => {
  const progress = Object.fromEntries(['flow', 'preload', 'afterload'].map((id) => [id,
    { ...emptyProgress(), lesson_completed: true, due_at: '2026-10-05T00:00:00Z' }]));
  const usual = planSession(fixturePack, progress, 20, now);
  const urgent = planSession(fixturePack, progress, 20, now, { examDate: '2026-10-07', today: '2026-10-06' });
  assert.equal(usual[1].concept_id, 'preload');
  assert.equal(urgent[0].concept_id, 'flow');
  assert.equal(urgent[1].concept_id, 'cycle');
  assert.ok(urgent.reduce((sum, step) => sum + step.estimated_minutes, 0) <= 20);
});

test('same item repeats and same day successes cannot falsely earn secure coverage', () => {
  let progress = { ...emptyProgress(), lesson_completed: true };
  for (let index = 0; index < 5; index++) progress = recordAnswer(progress, 'q1', true, 'confident', now, '2026-10-06');
  assert.equal(progress.distinct_correct, 1);
  assert.equal(progress.status, 'learning');
  progress = recordAnswer(progress, 'q2', true, 'confident', now, '2026-10-06');
  assert.equal(progress.status, 'learning');
  progress = recordAnswer(progress, 'q1', true, 'okay', new Date('2026-10-07T10:00:00Z'), '2026-10-07');
  assert.equal(progress.status, 'secure');
});

test('a mistake requires two distinct repair successes; uncertain success returns sooner', () => {
  let progress = recordAnswer(emptyProgress(), 'q0', false, 'confident', now, '2026-10-06');
  assert.equal(progress.status, 'needs_review');
  progress = recordAnswer(progress, 'q1', true, 'okay', now, '2026-10-06');
  progress = recordAnswer(progress, 'q1', true, 'okay', now, '2026-10-06');
  assert.equal(progress.status, 'needs_review');
  progress = recordAnswer(progress, 'q2', true, 'unsure', now, '2026-10-06');
  assert.equal(progress.needs_repair, false);
  assert.equal(progress.status, 'learning');
  assert.equal(progress.due_at, '2026-10-07T22:30:00.000Z');
});

test('public course and ungraded session never leak private question keys or evidence internals', () => {
  const detail = courseDetail(fixturePack, { flow: { ...emptyProgress(), correct_question_ids: ['secret-question'] } });
  assert.ok(!JSON.stringify(detail).includes('correct_index'));
  assert.ok(!JSON.stringify(detail).includes('secret-question'));
  const steps = planSession(fixturePack, {}, 10, now);
  const row = { id: 'session', course_id: fixturePack.id, course_title: fixturePack.title,
    pack_version: fixturePack.version, local_date: '2026-10-06', daily_minutes: 10, steps, status: 'active', completed_at: null };
  const session = serializeSession(row);
  const json = JSON.stringify(session);
  for (const key of ['correct_index', 'question_snapshot', 'misconceptions', 'explanation', 'pack_snapshot']) assert.ok(!json.includes(key));
  assert.equal(session.current_index, 0);
  const questionStep = steps.find((step) => step.type === 'question');
  const feedback = { correct: false, correct_index: 0, explanation: 'Graded explanation', misconception: 'Mistake', sources: [] };
  const graded = serializeSession(row, [{ step_id: steps[0].id, correct: null, feedback: null },
    { step_id: questionStep.id, option_index: 2, confidence: 'unsure', correct: false, feedback }]);
  assert.deepEqual(graded.steps.find((step) => step.id === questionStep.id).feedback, feedback);
  assert.deepEqual(graded.steps.find((step) => step.id === questionStep.id).answer,
    { option_index: 2, confidence: 'unsure' });
  assert.ok(!('answer' in graded.steps[0]));
  assert.ok(!('answer' in graded.steps.at(-1)));
  assert.equal(graded.steps.at(-1).feedback, null);
});
