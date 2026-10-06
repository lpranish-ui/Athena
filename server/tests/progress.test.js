import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeProgress } from '../src/progress.js';

const sets = [{ id: 'set-1', set_title: 'Cardio quiz', book_title: 'Cardio' }];
const questions = [
  { id: 'q1', topic: 'Conduction', correct_index: 0 },
  { id: 'q2', topic: 'Valves', correct_index: 1 },
  { id: 'q3', topic: 'Conduction', correct_index: 2 },
];

test('summarizeProgress aggregates totals, books and topics across attempts', () => {
  const summary = summarizeProgress({
    attempts: [
      {
        set_id: 'set-1',
        answers: [0, 0, 2],
        question_ids: ['q1', 'q2', 'q3'],
        duration_seconds: 120,
        score: 2,
        total: 3,
        mode: 'tutor',
        completed_at: '2026-10-06T00:00:00Z',
      },
      {
        set_id: 'set-1',
        answers: [1, 1, 2],
        question_ids: ['q1', 'q2', 'q3'],
        duration_seconds: 60,
        score: 2,
        total: 3,
        mode: 'exam',
        completed_at: '2026-10-06T00:01:00Z',
      },
    ],
    sets,
    questions,
  });

  assert.equal(summary.totals.attempts, 2);
  assert.equal(summary.totals.answered, 6);
  assert.equal(summary.totals.correct, 4);
  assert.equal(summary.totals.seconds, 180);
  assert.ok(Math.abs(summary.totals.accuracy - 4 / 6) < 1e-9);

  assert.equal(summary.books.length, 1);
  assert.equal(summary.books[0].book_title, 'Cardio');
  assert.equal(summary.books[0].attempts, 2);
  assert.equal(summary.books[0].answered, 6);

  // Conduction: 2/4 correct; Valves: 0/2 → weakest first.
  assert.equal(summary.topics[0].topic, 'Valves');
  assert.equal(summary.topics[1].topic, 'Conduction');

  assert.equal(summary.recent.length, 2);
  assert.equal(summary.recent[0].set_title, 'Cardio quiz');
});

test('attempts without question ids are counted but not attributed', () => {
  const summary = summarizeProgress({
    attempts: [
      {
        set_id: 'set-1',
        answers: [0, 1],
        question_ids: null,
        duration_seconds: 10,
        score: 2,
        total: 2,
        mode: 'tutor',
        completed_at: 'x',
      },
    ],
    sets,
    questions,
  });

  assert.equal(summary.totals.attempts, 1);
  assert.equal(summary.totals.answered, 0);
  assert.equal(summary.topics.length, 0);
  assert.equal(summary.books[0].attempts, 1);
  assert.equal(summary.books[0].answered, 0);
});

test('topics with a single answer stay out of weak areas', () => {
  const summary = summarizeProgress({
    attempts: [
      {
        set_id: 'set-1',
        answers: [9],
        question_ids: ['q2'],
        duration_seconds: 5,
        score: 0,
        total: 1,
        mode: 'tutor',
        completed_at: 'x',
      },
    ],
    sets,
    questions,
  });

  assert.equal(summary.topics.length, 0);
});
