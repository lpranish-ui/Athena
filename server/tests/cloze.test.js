import assert from 'node:assert/strict';
import test from 'node:test';

import { QUESTION_TYPES, validateQuestion } from '../src/questions.js';

const content =
  'The sinoatrial node sits in the right atrium and fires at roughly 60 to 100 times per minute in healthy adults.';
const chapter = {
  id: 'chapter-a',
  number: 2,
  title: 'Conduction',
  content,
  pageMap: [{ page: 7, char_start: 0 }],
};

const closure = {
  question:
    'The sinoatrial node sits in the right atrium and fires at roughly ______ times per minute in healthy adults.',
  options: ['60 to 100'],
  correct_index: 0,
  supporting_quote:
    'The sinoatrial node sits in the right atrium and fires at roughly 60 to 100 times per minute in healthy adults.',
  explanation: 'The SA node is the natural pacemaker at 60-100/min.',
  option_explanations: ['60 to 100 per minute is the normal SA node rate in adults.'],
  source_page: 7,
  topic: 'Conduction',
};

test('cloze validates with a blank, a single grounded term and correct_index 0', () => {
  assert.ok(QUESTION_TYPES.includes('cloze'));
  const valid = validateQuestion(closure, [chapter], 'cloze');
  assert.ok(valid);
  assert.equal(valid.options.length, 1);
  assert.equal(valid.correct_index, 0);
  assert.equal(valid.source_page, 7);
});

test('cloze rejects questions without a blank', () => {
  assert.equal(
    validateQuestion({ ...closure, question: 'No blank in this sentence.' }, [chapter], 'cloze'),
    null,
  );
});

test('cloze rejects extra options and non-zero correct_index', () => {
  assert.equal(
    validateQuestion({ ...closure, options: ['60 to 100', '120'] }, [chapter], 'cloze'),
    null,
  );
  assert.equal(
    validateQuestion({ ...closure, correct_index: 1 }, [chapter], 'cloze'),
    null,
  );
});

test('cloze rejects answers that do not appear in the supporting quote', () => {
  assert.equal(
    validateQuestion({ ...closure, options: ['mitral valve'] }, [chapter], 'cloze'),
    null,
  );
});
