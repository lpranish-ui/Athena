import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createGenerationWorker } from '../src/jobs.js';
import { HttpError } from '../src/http.js';

process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';
const { createApp } = await import('../src/app.js');
const connectionString = process.env.TEST_DATABASE_URL;
let pool, admin, database, server, base, userA, userB, schema;

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
  database = {
    query: (...args) => pool.query(...args),
    one: async (...args) => (await pool.query(...args)).rows[0] ?? null,
    many: async (...args) => (await pool.query(...args)).rows,
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  userA = (await database.one("insert into users(email,password_hash) values ('jobs-a@test.local','fixture') returning id")).id;
  userB = (await database.one("insert into users(email,password_hash) values ('jobs-b@test.local','fixture') returning id")).id;
  const app = createApp({ database, registerAuthentication: () => {}, aiLimiter: null,
    authenticate: (req, _res, next) => { req.user = { id: req.headers['x-test-user'] ?? userA }; next(); } });
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
  const response = await fetch(base + route, {
    method,
    headers: { 'x-test-user': user, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
const integration = (name, fn) => test(name, { skip: !connectionString }, fn);
const resetJobs = () => pool.query('delete from generation_jobs');
const chapterIds = [crypto.randomUUID()];

integration('enqueue validates payloads, enforces the active cap, and keeps jobs private', async () => {
  await resetJobs();
  assert.equal((await request('/api/ai/jobs', { method: 'POST', body: { kind: 'video' } })).status, 400);
  assert.equal((await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds: [] } })).status, 400);
  assert.equal(
    (await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds: Array.from({ length: 9 }, () => crypto.randomUUID()) } })).status,
    400,
  );
  assert.equal((await request('/api/ai/jobs', { method: 'POST', body: { kind: 'study_kit', chapterId: crypto.randomUUID() } })).status, 400);
  assert.equal((await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds, count: 1.5 } })).status, 400);

  const created = await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds, count: 10, difficulty: 'hard' } });
  assert.equal(created.status, 202);
  assert.equal(created.body.status, 'queued');
  const jobId = created.body.jobId;

  const mine = await request(`/api/ai/jobs/${jobId}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.kind, 'mcqs');
  assert.equal(mine.body.stage, 'Waiting to start…');
  assert.equal(mine.body.result, null);
  assert.equal(mine.body.error, null);

  assert.equal((await request(`/api/ai/jobs/${jobId}`, { user: userB })).status, 404);
  assert.equal((await request('/api/ai/jobs/not-a-uuid')).status, 404);

  const activeA = await request('/api/ai/jobs?active=1');
  assert.equal(activeA.body.jobs.length, 1);
  const activeB = await request('/api/ai/jobs?active=1', { user: userB });
  assert.equal(activeB.body.jobs.length, 0);

  assert.equal((await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds, count: 5 } })).status, 202);
  assert.equal(
    (await request('/api/ai/jobs', { method: 'POST', body: { kind: 'study_kit', chapterId: crypto.randomUUID(), material: 'flashcards' } })).status,
    202,
  );
  assert.equal((await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds } })).status, 429);
});

integration('the worker claims one job at a time, reports stages, and stores results', async () => {
  await resetJobs();
  const created = await request('/api/ai/jobs', {
    method: 'POST',
    body: { kind: 'mcqs', chapterIds, count: 10, difficulty: 'hard', questionType: 'cloze' },
  });
  const jobId = created.body.jobId;

  const calls = [];
  const worker = createGenerationWorker({
    database,
    maxAttempts: 2,
    execute: async ({ userId, kind, payload, onStage }) => {
      calls.push({ userId, kind, payload });
      await onStage('Drafting questions…');
      const mid = await database.one("select stage from generation_jobs where status = 'running'");
      assert.equal(mid.stage, 'Drafting questions…');
      return { setId: 'set-1', count: 10, total: 10 };
    },
  });

  assert.equal(await worker.runOnce(), true);
  assert.equal(await worker.runOnce(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'mcqs');
  assert.deepEqual(calls[0].payload.chapterIds, chapterIds);
  assert.equal(calls[0].payload.difficulty, 'hard');

  const done = await request(`/api/ai/jobs/${jobId}`);
  assert.equal(done.body.status, 'done');
  assert.equal(done.body.stage, 'Ready');
  assert.deepEqual(done.body.result, { setId: 'set-1', count: 10, total: 10 });
  const row = await database.one('select attempts from generation_jobs where id = $1', [jobId]);
  assert.equal(row.attempts, 1);
});

integration('permanent failures surface immediately while transient ones retry once', async () => {
  await resetJobs();
  const first = await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds } });
  const second = await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds } });

  const failures = [
    () => {
      throw new HttpError(400, 'Choose at least one chapter.');
    },
    () => {
      throw new Error('socket hang up');
    },
    () => {
      throw new Error('socket hang up');
    },
  ];
  const worker = createGenerationWorker({ database, maxAttempts: 2, execute: async () => failures.shift()() });

  await worker.runOnce(); // first job: permanent validation failure
  await worker.runOnce(); // second job: transient failure -> requeued
  await worker.runOnce(); // second job: transient failure again -> final

  const failed = await request(`/api/ai/jobs/${first.body.jobId}`);
  assert.equal(failed.body.status, 'failed');
  assert.equal(failed.body.error, 'Choose at least one chapter.');

  const retried = await request(`/api/ai/jobs/${second.body.jobId}`);
  assert.equal(retried.body.status, 'failed');
  assert.equal(retried.body.error, 'Generation failed. Please try again.');

  const row = await database.one('select attempts from generation_jobs where id = $1', [second.body.jobId]);
  assert.equal(row.attempts, 2);
});

integration('expired leases are reclaimed, live leases are untouched, and exhausted jobs stop', async () => {
  await resetJobs();
  const first = await request('/api/ai/jobs', {
    method: 'POST',
    body: { kind: 'study_kit', chapterId: crypto.randomUUID(), material: 'summary' },
  });
  let calls = 0;
  const worker = createGenerationWorker({
    database,
    maxAttempts: 2,
    execute: async ({ kind, payload }) => {
      calls += 1;
      assert.equal(kind, 'study_kit');
      assert.equal(payload.material, 'summary');
      return { kind: 'summary', content: { overview: 'ok', points: [] } };
    },
  });

  // A crashed run left an expired lease; the job is reclaimed and completes.
  await pool.query(
    `update generation_jobs
        set status = 'running', attempts = 1, lease_token = gen_random_uuid(),
            lease_at = now() - interval '1 hour'
      where id = $1`,
    [first.body.jobId],
  );
  assert.equal(await worker.runOnce(), true);
  const done = await request(`/api/ai/jobs/${first.body.jobId}`);
  assert.equal(done.body.status, 'done');
  assert.equal(calls, 1);

  // A live lease (another worker is on it) must not be stolen.
  const live = await request('/api/ai/jobs', { method: 'POST', body: { kind: 'mcqs', chapterIds } });
  await pool.query(
    `update generation_jobs set status = 'running', attempts = 1, lease_token = gen_random_uuid(), lease_at = now() where id = $1`,
    [live.body.jobId],
  );
  assert.equal(await worker.runOnce(), false);
  assert.equal(calls, 1);

  // Once attempts are exhausted the job fails instead of running again.
  await pool.query("update generation_jobs set attempts = 2, lease_at = now() - interval '1 hour' where id = $1", [live.body.jobId]);
  await worker.runOnce();
  assert.equal(calls, 1);
  const exhausted = await request(`/api/ai/jobs/${live.body.jobId}`);
  assert.equal(exhausted.body.status, 'failed');
  assert.equal(exhausted.body.error, 'Generation was interrupted before it could finish. Please try again.');
});
