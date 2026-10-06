import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pack = JSON.parse(await readFile(new URL('../data/course-packs/cardiovascular-foundations.json', import.meta.url), 'utf8'));

test('pilot content has stable identities, complete teaching material, and explicit review status', () => {
  assert.match(pack.id, /^[a-z][a-z0-9-]+$/);
  assert.match(pack.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pack.review_status, 'draft');
  assert.match(pack.review_note, /review pending/i);
  assert.equal(pack.rights.commercial_distribution, 'original_content');
  assert.ok(pack.concepts.length >= 8);
  const ids = new Set([pack.id]);
  for (const concept of pack.concepts) {
    assert.match(concept.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(!ids.has(concept.id), `Duplicate identity: ${concept.id}`);
    ids.add(concept.id);
    assert.ok(concept.title.length > 5 && concept.objective.length > 20);
    const wordCount = concept.lesson.trim().split(/\s+/).length;
    assert.ok(wordCount >= 80 && wordCount <= 125, `${concept.id} lesson length: ${wordCount}`);
    assert.equal(concept.key_points.length, 3);
    assert.equal(new Set(concept.key_points).size, 3);
    assert.ok(concept.key_points.every(point => typeof point === 'string' && point.length > 15));
    assert.ok(Number.isInteger(concept.estimated_minutes) && concept.estimated_minutes > 0);
    assert.ok(concept.sources.length > 0);
    for (const source of concept.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(source.title.length > 10 && source.section.length > 5);
    }
    assert.ok(concept.questions.length >= 3, `${concept.id} needs fresh question variants`);
    for (const question of concept.questions) {
      assert.match(question.id, new RegExp(`^${concept.id}-q\\d+$`));
      assert.ok(!ids.has(question.id), `Duplicate identity: ${question.id}`);
      ids.add(question.id);
    }
  }
});

test('each practice item supports unambiguous grading and option-specific mistake repair', () => {
  const prompts = new Set();
  const keyPositions = new Set();
  for (const concept of pack.concepts) {
    const correctAnswers = new Set();
    for (const question of concept.questions) {
      assert.ok(question.prompt.length > 25);
      assert.ok(!prompts.has(question.prompt.toLowerCase()), `Repeated prompt: ${question.id}`);
      prompts.add(question.prompt.toLowerCase());
      assert.equal(question.options.length, 4);
      assert.equal(new Set(question.options.map(option => option.trim().toLowerCase())).size, 4);
      assert.ok(question.options.every(option => typeof option === 'string' && option.trim().length > 0));
      assert.ok(Number.isInteger(question.correct_index));
      assert.ok(question.correct_index >= 0 && question.correct_index < question.options.length);
      keyPositions.add(question.correct_index);
      correctAnswers.add(question.options[question.correct_index]);
      assert.ok(question.explanation.trim().split(/\s+/).length >= 35, `${question.id} needs explanatory feedback`);
      assert.equal(question.misconceptions.length, question.options.length);
      for (const [index, feedback] of question.misconceptions.entries()) {
        assert.equal(typeof feedback, 'string');
        if (index !== question.correct_index) assert.ok(feedback.length > 20, `${question.id}, option ${index} needs repair feedback`);
      }
    }
    assert.ok(correctAnswers.size > 1, `${concept.id} variants must assess different responses`);
  }
  assert.equal(keyPositions.size, 4, 'Answer positions should vary across the pack');
});
