import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { fixturePack } from './study-fixture.js';
import { createStudyService } from '../src/study.js';

process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';
const { createApp } = await import('../src/app.js');
const connectionString = process.env.TEST_DATABASE_URL;
let pool, admin, database, server, base, userA, userB, schema;
let clock = new Date('2026-10-06T22:30:00Z');
let currentPack = structuredClone(fixturePack);
const serviceOptions = { now: () => clock, loadPacks: async () => [currentPack] };

before(async () => {
  if (!connectionString) return;
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/athena_test');
  schema = `test_${crypto.randomUUID().replaceAll('-', '')}`;
  admin = new pg.Pool({ connectionString, max: 1 });
  await admin.query(`create schema ${schema}`);
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema},public`, max: 8 });
  await pool.query(await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  database = { query: (...args) => pool.query(...args),
    one: async (...args) => (await pool.query(...args)).rows[0] ?? null,
    many: async (...args) => (await pool.query(...args)).rows,
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; }
      catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    } };
  userA = (await database.one("insert into users(email,password_hash) values ('coach-a@test.local','fixture') returning id")).id;
  userB = (await database.one("insert into users(email,password_hash) values ('coach-b@test.local','fixture') returning id")).id;
  const app = createApp({ database, registerAuthentication: () => {}, aiLimiter: null,
    authenticate: (req, _res, next) => { req.user = { id: req.headers['x-test-user'] ?? userA }; next(); },
    services: { studyNow: serviceOptions.now, studyPacks: serviceOptions.loadPacks } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) { if (schema) await admin.query(`drop schema ${schema} cascade`); await admin.end(); }
});
async function request(route, { method = 'GET', body, user = userA } = {}) {
  const response = await fetch(base + route, { method, headers: { 'x-test-user': user,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const integration = (name, fn) => test(name, { skip: !connectionString }, fn);
const enroll = (daily_minutes = 25) => request('/api/study/enrollment', { method: 'PUT',
  body: { course_id: fixturePack.id, daily_minutes, exam_date: null, timezone: 'Asia/Kathmandu' } });

integration('read-only empty dashboard, strict enrollment, and local-day planning validation', async () => {
  const beforeRead = await database.one('select count(*)::int as count from study_concept_progress');
  const dashboard = await request('/api/study/dashboard');
  assert.equal(dashboard.status, 200); assert.equal(dashboard.body.enrollment, null);
  assert.equal(dashboard.body.local_date, null);
  assert.deepEqual(await database.one('select count(*)::int as count from study_concept_progress'), beforeRead);
  assert.equal((await enroll(9)).status, 400);
  assert.equal((await request('/api/study/enrollment', { method: 'PUT', body: {
    course_id: fixturePack.id, daily_minutes: 25, timezone: 'Invalid/Timezone' } })).status, 400);
  assert.equal((await enroll()).status, 200);
  assert.equal((await request('/api/study/dashboard')).body.local_date, '2026-10-07');
  assert.equal((await request('/api/study/sessions', { method: 'POST', body: { date: '2026-10-06' } })).status, 400);
  assert.equal((await request('/api/study/sessions', { method: 'POST', body: { date: '2026-02-30' } })).status, 400);
  assert.equal((await request('/api/study/dashboard?date=2026-10-08')).status, 400);
});

integration('concurrent starts resume one private versioned session and reject foreign access', async () => {
  const responses = await Promise.all(Array.from({ length: 5 }, () => request('/api/study/sessions', { method: 'POST', body: {} })));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(new Set(responses.map((response) => response.body.id)).size, 1);
  const session = responses[0].body;
  const publicJson = JSON.stringify(session);
  for (const key of ['correct_index', 'question_snapshot', 'misconceptions', 'explanation', 'pack_snapshot']) assert.ok(!publicJson.includes(key));
  assert.equal((await database.one('select count(*)::int as count from study_sessions where user_id=$1', [userA])).count, 1);
  const stored = await database.one('select pack_snapshot,steps from study_sessions where id=$1', [session.id]);
  assert.equal(stored.pack_snapshot.version, 'test-1');
  assert.equal(stored.steps.find((step) => step.type === 'question').question_snapshot.correct_index, 0);
  assert.equal((await request(`/api/study/sessions/${session.id}`, { user: userB })).status, 404);
  assert.equal((await request(`/api/study/sessions/${session.id}/steps/step-1`, { user: userB, method: 'POST', body: {} })).status, 404);
  assert.equal((await request('/api/study/sessions/not-a-uuid')).status, 400);
});

integration('ordered server grading, concurrent retry idempotence, exact snapshots, and mistake persistence', async () => {
  const started = await request('/api/study/sessions', { method: 'POST', body: {} });
  let session = started.body;
  const firstQuestion = session.steps.find((step) => step.type === 'question');
  assert.equal((await request(`/api/study/sessions/${session.id}/steps/${firstQuestion.id}`, { method: 'POST', body: { option_index: 0 } })).status, 409);
  assert.equal((await request(`/api/study/sessions/${session.id}/steps/${session.steps[0].id}`, { method: 'POST', body: { correct: true } })).status, 400);
  const lesson = await request(`/api/study/sessions/${session.id}/steps/${session.steps[0].id}`, { method: 'POST', body: {} });
  assert.equal(lesson.status, 200); assert.equal(lesson.body.feedback, null);
  // Edit the live pack; existing sessions retain the original grading and feedback.
  currentPack = structuredClone(fixturePack); currentPack.version = 'test-2';
  currentPack.concepts[0].questions[0].correct_index = 1;
  currentPack.concepts[0].questions[0].explanation = 'Changed pack explanation';
  const replies = await Promise.all(Array.from({ length: 4 }, () => request(`/api/study/sessions/${session.id}/steps/${firstQuestion.id}`,
    { method: 'POST', body: { option_index: 1, confidence: 'confident' } })));
  assert.ok(replies.every((reply) => reply.status === 200));
  assert.equal(replies[0].body.feedback.correct, false);
  assert.equal(replies[0].body.feedback.correct_index, 0);
  assert.equal(replies[0].body.feedback.explanation, 'flow explanation');
  const reloaded = await request(`/api/study/sessions/${session.id}`);
  assert.equal(reloaded.status, 200);
  assert.deepEqual(reloaded.body.steps.find((step) => step.id === firstQuestion.id).answer,
    { option_index: 1, confidence: 'confident' });
  assert.ok(!('answer' in reloaded.body.steps[0]));
  assert.ok(reloaded.body.steps.filter((step) => !step.completed).every((step) => !('answer' in step)));
  const progress = await database.one('select state from study_concept_progress where user_id=$1 and concept_id=$2', [userA, 'flow']);
  assert.equal(progress.state.attempts, 1);
  assert.equal(progress.state.status, 'needs_review');
  assert.equal((await database.one('select count(*)::int as count from study_step_answers where session_id=$1 and step_id=$2', [session.id, firstQuestion.id])).count, 1);
  assert.equal((await request(`/api/study/sessions/${session.id}/steps/${firstQuestion.id}`, { method: 'POST', body: { option_index: 0, confidence: 'confident' } })).status, 409);
  assert.equal((await request('/api/study/dashboard')).body.mistakes[0].misconception, 'Confuses mechanisms');
  session = replies[0].body.session;
  // Finish this session so the completion summary is durably resumable.
  while (session.status === 'active') {
    const step = session.steps[session.current_index];
    const response = await request(`/api/study/sessions/${session.id}/steps/${step.id}`, { method: 'POST',
      body: step.type === 'lesson' ? {} : { option_index: 0, confidence: 'okay' } });
    assert.equal(response.status, 200); session = response.body.session;
  }
  assert.equal(session.summary.correct_answers, session.summary.questions_answered - 1);
  const refreshed = await request(`/api/study/sessions/${session.id}`);
  assert.deepEqual(refreshed.body, session);
  assert.equal((await request('/api/study/sessions', { method: 'POST', body: {} })).body.id, session.id);
});

integration('next day prioritizes a fresh repair variant and clears journal after distinct successes', async () => {
  clock = new Date('2026-10-07T22:30:00Z');
  currentPack = structuredClone(fixturePack);
  currentPack.version = 'test-2';
  const started = await request('/api/study/sessions', { method: 'POST', body: {} });
  assert.equal(started.status, 200);
  let session = started.body;
  assert.equal(session.local_date, '2026-10-08');
  assert.equal(session.steps[0].kind, 'repair');
  assert.equal(session.steps[0].concept_id, 'flow');
  assert.equal(session.steps[1].question.id, 'flow-q1');
  const service = createStudyService(database, serviceOptions);
  while (session.status === 'active') {
    const step = session.steps[session.current_index];
    const response = await service.answer(userA, session.id, step.id, step.type === 'lesson' ? {} : { option_index: 0 });
    session = response.session;
  }
  const dashboard = await service.dashboard(userA);
  assert.equal(dashboard.summary.completed_sessions, 2);
  assert.equal(dashboard.recent_sessions.length, 2);
  const state = (await database.one('select state from study_concept_progress where user_id=$1 and concept_id=$2', [userA, 'flow'])).state;
  // A 25-minute plan has room for the fresh repair question; a second distinct success resolves it.
  if (state.needs_repair) {
    clock = new Date('2026-10-08T22:30:00Z');
    let third = await service.start(userA, {});
    while (third.status === 'active') {
      const step = third.steps[third.current_index];
      third = (await service.answer(userA, third.id, step.id, step.type === 'lesson' ? {} : { option_index: 0 })).session;
    }
  }
  const repaired = (await service.dashboard(userA)).mistakes.find((mistake) => mistake.concept_id === 'flow');
  assert.equal(repaired.resolved, true);
});

integration('answer failure rolls back lesson evidence, answers, and session completion together', async () => {
  clock = new Date('2026-10-10T22:30:00Z');
  const service = createStudyService(database, serviceOptions);
  const session = await service.start(userA, {});
  const step = session.steps[0];
  const beforeProgress = await database.many('select * from study_concept_progress where user_id=$1 order by concept_id', [userA]);
  const failingDatabase = { ...database, withTransaction: (fn) => database.withTransaction((client) => fn({
    query: (sql, values) => {
      if (sql.includes('insert into study_step_answers')) throw new Error('Simulated storage failure');
      return client.query(sql, values);
    },
  })) };
  const failingService = createStudyService(failingDatabase, serviceOptions);
  await assert.rejects(() => failingService.answer(userA, session.id, step.id, step.type === 'lesson' ? {} : { option_index: 1 }), /Simulated storage failure/);
  assert.deepEqual(await database.many('select * from study_concept_progress where user_id=$1 order by concept_id', [userA]), beforeProgress);
  assert.equal((await service.session(userA, session.id)).current_index, 0);
  assert.equal((await database.one('select count(*)::int as count from study_step_answers where session_id=$1', [session.id])).count, 0);
  await service.dashboard(userA);
  await service.course(userA, fixturePack.id);
  await service.session(userA, session.id);
  assert.deepEqual(await database.many('select * from study_concept_progress where user_id=$1 order by concept_id', [userA]), beforeProgress);
});

integration('track preferences and syllabus mappings are durable, private, and explicitly confirmed', async () => {
  const body = { track: 'usmle', goal: 'Step 1', syllabus_text: 'Explain cycle\nRenal filtration' };
  assert.equal((await request('/api/study/preferences', { method: 'PUT', body })).status, 200);
  assert.equal((await request('/api/study/preferences')).body.track, 'usmle');
  assert.equal((await request('/api/study/preferences', { user: userB })).body.track, 'mbbs');
  assert.equal((await request('/api/study/preferences', { method: 'PUT', body: { track: 'bad' } })).status, 400);
  const imported = await request('/api/study/syllabus/import', { method: 'POST', body: { text: body.syllabus_text } });
  assert.equal(imported.status, 200); assert.equal(imported.body.summary.mapped, 0);
  const objective = imported.body.items[0];
  assert.equal(objective.suggestions[0].concept_id, 'cycle');
  const link = { links: [{ course_id: fixturePack.id, concept_id: 'cycle' }] };
  assert.equal((await request(`/api/study/syllabus/${objective.id}`, { user: userB, method: 'PUT', body: link })).status, 404);
  assert.equal((await request('/api/study/syllabus', { user: userB })).body.summary.total, 0);
  assert.equal((await request(`/api/study/syllabus/${objective.id}`, { method: 'PUT', body: link })).body.summary.mapped, 1);
  assert.equal((await request('/api/study/syllabus')).body.items[0].links[0].concept_id, 'cycle');
  assert.equal((await request(`/api/study/syllabus/${objective.id}`, { method: 'PUT', body: { links: [{ course_id: fixturePack.id, concept_id: 'nonexistent' }] } })).status, 400);
  const invalid = await request('/api/study/syllabus/import', { method: 'POST', body: { text: 'x'.repeat(201) } });
  assert.equal(invalid.status, 400); assert.equal((await request('/api/study/syllabus')).body.summary.mapped, 1);
  assert.equal((await request('/api/study/syllabus/import', { method: 'POST', body: { text: '-\n*\n1.' } })).status, 400);
  assert.equal((await request('/api/study/syllabus')).body.summary.mapped, 1);
  assert.equal((await request('/api/study/syllabus/import', { method: 'POST', body: { text: 'Explain flow' } })).body.summary.total, 1);
  assert.equal((await request('/api/study/syllabus')).body.summary.mapped, 0);
});

integration('course reports are private, bounded, versioned, and reject foreign question locations', async () => {
  const report = { course_id: fixturePack.id, concept_id: 'flow', category: 'source', message: 'The reference section is unclear.' };
  assert.equal((await request('/api/study/reports', { method: 'POST', body: { ...report, question_id: 'cycle-q0' } })).status, 400);
  const submitted = await request('/api/study/reports', { method: 'POST', body: report });
  assert.equal(submitted.status, 201); assert.equal(submitted.body.status, 'open');
  assert.equal((await request('/api/study/reports', { user: userB })).body.length, 0);
  assert.equal((await database.one('select pack_version from course_reports where id=$1', [submitted.body.id])).pack_version, currentPack.version);
  const oldSession = await database.one('select id,pack_version from study_sessions where user_id=$1 order by local_date limit 1', [userA]);
  const historical = await request('/api/study/reports', { method: 'POST', body: { ...report, session_id: oldSession.id } });
  assert.equal(historical.status, 201);
  assert.equal((await database.one('select pack_version from course_reports where id=$1', [historical.body.id])).pack_version, oldSession.pack_version);
  assert.equal((await request('/api/study/reports', { method: 'POST', user: userB, body: { ...report, session_id: oldSession.id } })).status, 404);
  for (let i = 2; i < 20; i++) assert.equal((await request('/api/study/reports', { method: 'POST', body: report })).status, 201);
  assert.equal((await request('/api/study/reports', { method: 'POST', body: report })).status, 429);
});

integration('learning events stay transactional and duplicate completion retries do not inflate metrics', async () => {
  const duplicate = await database.many('select user_id,event_name,event_key,count(*) from learning_events group by user_id,event_name,event_key having count(*)>1');
  assert.equal(duplicate.length, 0);
  const finished = await database.one("select count(*)::int as count from study_sessions where user_id=$1 and status='completed'", [userA]);
  const recorded = await database.one("select count(*)::int as count from learning_events where user_id=$1 and event_name='session_completed'", [userA]);
  assert.equal(recorded.count, finished.count);
});
