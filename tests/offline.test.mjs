import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateOfflineStorage, isOfflineNetworkError, OfflineAccountChangedError, PRIVATE_OFFLINE_PREFIX } from '../src/lib/offlineStorage.ts';
import { displayOfflineSession, enqueueStudyStep, flushPendingStudySteps, mergeFetchedStudySession, reconcileStudySteps } from '../src/lib/offlineStudy.ts';

function storageFixture() {
  const data = new Map();
  const adapter = {
    async getItem(key) { return data.get(key) ?? null; },
    async setItem(key, value) { data.set(key, value); },
    async getAllKeys() { return [...data.keys()]; },
    async multiRemove(keys) { for (const key of keys) data.delete(key); },
  };
  return { data, adapter, store: createPrivateOfflineStorage(adapter) };
}
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function sessionFixture() {
  return {
    id: 'session-a', course_id: 'course', course_title: 'Course', pack_version: '1', local_date: '2026-10-07', daily_minutes: 10,
    status: 'active', current_index: 0, estimated_minutes: 3, completed_at: null,
    summary: { questions_answered: 0, correct_answers: 0, concepts_practiced: 0 },
    steps: [
      { id: 'lesson', type: 'lesson', kind: 'new', concept_id: 'c', title: 'Lesson', lesson: 'Read', sources: [], estimated_minutes: 1, completed: false, feedback: null },
      { id: 'question', type: 'question', kind: 'new', concept_id: 'c', title: 'Question', sources: [], estimated_minutes: 1, question: { id: 'q', prompt: 'Choose', options: ['A', 'B'] }, completed: false, feedback: null },
    ],
  };
}
const cacheFixture = () => ({ session: sessionFixture(), pending: [], saved_at: '2026-10-07T00:00:00.000Z' });
const answer = { option_index: 1, confidence: 'confident' };
function savedStep(server, stepId, input) {
  const value = structuredClone(server);
  const step = value.steps.find((entry) => entry.id === stepId);
  step.completed = true;
  if (step.type === 'question') { step.answer = { ...input }; step.feedback = { correct: false, correct_index: 0, explanation: 'Server feedback', misconception: 'Review', sources: [] }; }
  const next = value.steps.findIndex((entry) => !entry.completed);
  value.current_index = next < 0 ? value.steps.length : next;
  value.status = next < 0 ? 'completed' : 'active';
  return value;
}

test('private cache is account-scoped and account switching removes the prior account', async () => {
  const { store, data } = storageFixture();
  await store.setAccount('a');
  const old = store.lease();
  await store.write(old, 'study.session', { secret: 'a' });
  await store.setAccount('b');
  assert.equal(await store.read(store.lease(), 'study.session'), null);
  assert.equal([...data.keys()].filter((key) => key.startsWith(PRIVATE_OFFLINE_PREFIX)).length, 0);
  await assert.rejects(store.read(old, 'study.session'), OfflineAccountChangedError);
  await assert.rejects(store.write(old, 'study.session', { secret: 'late a' }), OfflineAccountChangedError);
});

test('legacy unscoped downloads are purged without migration or clearing auth settings', async () => {
  const { store, data } = storageFixture();
  data.set('athena.offline.book.meta', '{"secret":"old"}');
  data.set('athena.offline.book.ch.chapter', '{"secret":"old"}');
  data.set('athena.auth.token', 'token');
  await store.setAccount('a');
  assert.deepEqual([...data.keys()], ['athena.auth.token']);
  assert.equal(await store.read(store.lease(), 'books.book.meta'), null);
});

test('logout invalidates synchronously and waits for then removes an in-flight write', async () => {
  const { store, data, adapter } = storageFixture();
  const entered = deferred(); const release = deferred();
  adapter.setItem = async (key, value) => { entered.resolve(); await release.promise; data.set(key, value); };
  await store.setAccount('a');
  const lease = store.lease();
  const write = store.write(lease, 'study.pending', { answer: 1 });
  await entered.promise;
  const clear = store.clear();
  assert.throws(() => store.lease(), OfflineAccountChangedError);
  assert.equal(store.current(lease), false);
  release.resolve();
  await assert.rejects(write, OfflineAccountChangedError);
  await clear;
  assert.equal(data.size, 0);
});

test('a delayed cache read cannot return private content after logout', async () => {
  const { store, data, adapter } = storageFixture();
  await store.setAccount('a');
  const lease = store.lease(); await store.write(lease, 'books.book', { text: 'private' });
  const entered = deferred(); const release = deferred();
  adapter.getItem = async (key) => { const value = data.get(key); entered.resolve(); await release.promise; return value; };
  const read = store.read(lease, 'books.book'); await entered.promise;
  const clear = store.clear(); release.resolve();
  await assert.rejects(read, OfflineAccountChangedError); await clear;
});

test('offline fallback accepts network errors only, never authorization, missing resources or server errors', () => {
  for (const status of [401, 403, 404, 409, 429, 500]) {
    const error = Object.assign(new Error('Failed'), { status });
    assert.equal(isOfflineNetworkError(error), false);
  }
  assert.equal(isOfflineNetworkError(Object.assign(new Error('Offline'), { status: 0 })), true);
  assert.equal(isOfflineNetworkError(new Error('Unknown')), false);
});

test('offline choices advance local display without exposing grades or changing server mastery', () => {
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {});
  cache = enqueueStudyStep(cache, 'question', answer);
  const display = displayOfflineSession(cache, true);
  assert.equal(display.current_index, 2);
  assert.equal(display.status, 'active');
  assert.deepEqual(display.offline.pending_steps, ['lesson', 'question']);
  assert.deepEqual(display.steps[1].answer, answer);
  assert.equal(display.steps[1].feedback, null);
  assert.equal(display.steps[1].completed, false);
  assert.equal(display.summary.questions_answered, 0);
  assert.equal('correct_index' in display.steps[1].question, false);
});

test('queue enforces step ordering, validates answer bounds, and does not duplicate or replace choices', () => {
  assert.throws(() => enqueueStudyStep(cacheFixture(), 'question', answer), /earlier/);
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {});
  assert.throws(() => enqueueStudyStep(cache, 'question', { option_index: 8, confidence: 'confident' }), /Choose/);
  cache = enqueueStudyStep(cache, 'question', answer);
  assert.equal(enqueueStudyStep(cache, 'question', answer), cache);
  assert.throws(() => enqueueStudyStep(cache, 'question', { option_index: 0, confidence: 'unsure' }), /already saved locally/);
});

test('sync submits lessons and choices in order and persists each authoritative response', async () => {
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {}); cache = enqueueStudyStep(cache, 'question', answer);
  let server = sessionFixture(); const submitted = []; const persisted = [];
  const result = await flushPendingStudySteps(cache, async () => server, async (item) => {
    submitted.push([item.step_id, item.input]); server = savedStep(server, item.step_id, item.input); return server;
  }, async (value) => { persisted.push(structuredClone(value)); });
  assert.deepEqual(submitted, [['lesson', {}], ['question', answer]]);
  assert.deepEqual(persisted.map((value) => value.pending.length), [2, 1, 0]);
  assert.equal(result.session.status, 'completed'); assert.equal(result.session.steps[1].feedback.explanation, 'Server feedback');
});

test('a lost response is reconciled on retry without resubmitting already committed steps', async () => {
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {}); cache = enqueueStudyStep(cache, 'question', answer);
  let server = sessionFixture(); let persisted = cache;
  await assert.rejects(flushPendingStudySteps(cache, async () => server, async (item) => {
    server = savedStep(server, item.step_id, item.input); throw Object.assign(new Error('Offline'), { status: 0 });
  }, async (value) => { persisted = value; }), /Offline/);
  const submitted = [];
  const result = await flushPendingStudySteps(persisted, async () => server, async (item) => {
    submitted.push(item.step_id); server = savedStep(server, item.step_id, item.input); return server;
  }, async () => {});
  assert.deepEqual(submitted, ['question']); assert.equal(result.pending.length, 0);
});

test('conflicting answers saved by another device keep local choices for explicit resolution', () => {
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {}); cache = enqueueStudyStep(cache, 'question', answer);
  let server = savedStep(sessionFixture(), 'lesson', {}); server = savedStep(server, 'question', { option_index: 0, confidence: 'unsure' });
  assert.throws(() => reconcileStudySteps(cache, server), /different answers/);
  assert.equal(cache.pending.length, 2); assert.deepEqual(cache.pending[1].input, answer);
});

test('starting or resuming an existing session preserves unsynced choices and only drops matching committed work', () => {
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {}); cache = enqueueStudyStep(cache, 'question', answer);
  const sameSession = mergeFetchedStudySession(cache, sessionFixture());
  assert.deepEqual(sameSession.pending.map((item) => item.step_id), ['lesson', 'question']);
  const server = savedStep(sessionFixture(), 'lesson', {});
  const resumed = mergeFetchedStudySession(sameSession, server);
  assert.deepEqual(resumed.pending, [cache.pending[1]]);
  assert.deepEqual(resumed.pending[0].input, answer);
  assert.equal(resumed.session.steps[0].completed, true);
});

test('interrupted sync keeps the remaining queue after persisting acknowledged progress', async () => {
  let cache = enqueueStudyStep(cacheFixture(), 'lesson', {}); cache = enqueueStudyStep(cache, 'question', answer);
  let server = sessionFixture(); let persisted = cache;
  await assert.rejects(flushPendingStudySteps(cache, async () => server, async (item) => {
    if (item.step_id === 'question') throw Object.assign(new Error('Deadline reached'), { status: 0 });
    server = savedStep(server, item.step_id, item.input); return server;
  }, async (value) => { persisted = value; }), /Deadline/);
  assert.deepEqual(persisted.pending.map((item) => item.step_id), ['question']);
  assert.equal(persisted.session.steps[0].completed, true);
  assert.deepEqual(persisted.pending[0].input, answer);
});
