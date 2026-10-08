import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createAiLimiter } from '../src/ai-limit.js';

const connectionString = process.env.TEST_DATABASE_URL;
let pool, admin, database, schema, userA, userB;

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
  database = { query: (...args) => pool.query(...args) };
  userA = (await database.query("insert into users(email,password_hash) values ('limit-a@test.local','fixture') returning id")).rows[0].id;
  userB = (await database.query("insert into users(email,password_hash) values ('limit-b@test.local','fixture') returning id")).rows[0].id;
});
after(async () => {
  if (pool) await pool.end();
  if (admin) { if (schema) await admin.query(`drop schema ${schema} cascade`); await admin.end(); }
});

async function request(limiter, id = 'student', method = 'POST') {
  const res = new EventEmitter();
  res.set = () => res;
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  let accepted = false;
  await limiter({ user: id === null ? undefined : { id }, method }, res, () => { accepted = true; });
  return { res, accepted };
}

async function logCall(userId, ageMs = 0) {
  await pool.query(
    `insert into ai_calls (user_id, purpose, model, created_at)
     values ($1, 'test', 'test-model', now() - ($2::int * interval '1 millisecond'))`,
    [userId, ageMs],
  );
}

const integration = (name, fn) => test(name, { skip: !connectionString }, fn);

test('concurrent AI work is bounded per account and released exactly once', async () => {
  const limiter = createAiLimiter({ database: null, maxConcurrent: 1 });
  const first = await request(limiter);
  assert.equal(first.accepted, true);
  assert.equal((await request(limiter)).res.statusCode, 429);
  assert.equal((await request(limiter, 'other')).accepted, true);
  first.res.emit('finish');
  first.res.emit('close');
  assert.equal((await request(limiter)).accepted, true);
});

test('disconnecting a client does not free its still-running AI work', async () => {
  const limiter = createAiLimiter({ database: null, maxConcurrent: 1 });
  const first = await request(limiter);
  first.res.emit('close');
  assert.equal((await request(limiter)).res.statusCode, 429);
  first.res.end();
  first.res.emit('finish');
  assert.equal((await request(limiter)).accepted, true);
  assert.equal((await request(limiter)).res.statusCode, 429);
});

test('polling and unauthenticated traffic bypass AI limits', async () => {
  const limiter = createAiLimiter({ database: null, maxConcurrent: 1 });
  assert.equal((await request(limiter, 'student', 'GET')).accepted, true);
  assert.equal((await request(limiter, null)).accepted, true);
});

integration('budgets count provider calls in the sliding window and persist across instances', async () => {
  const limiter = createAiLimiter({ database, maxRequests: 4, maxGlobalRequests: 100 });
  const first = await request(limiter, userA);
  assert.equal(first.accepted, true);
  first.res.emit('finish');

  await logCall(userA, 0);
  await logCall(userA, 0);
  await logCall(userA, 0);
  await logCall(userA, 2 * 60 * 60 * 1000); // outside the window: must not count
  const second = await request(limiter, userA);
  assert.equal(second.accepted, true);
  second.res.emit('finish');

  await logCall(userA, 0); // four in-window calls now
  assert.equal((await request(limiter, userA)).res.statusCode, 429);

  // A fresh limiter instance sees the same persisted budget.
  const fresh = createAiLimiter({ database, maxRequests: 4, maxGlobalRequests: 100 });
  assert.equal((await request(fresh, userA)).res.statusCode, 429);
  assert.equal((await request(fresh, userB)).accepted, true);
});

integration('the shared global budget blocks new accounts too', async () => {
  await pool.query('delete from ai_calls');
  await logCall(userA, 0);
  await logCall(userA, 0);
  const limiter = createAiLimiter({ database, maxRequests: 50, maxGlobalRequests: 2 });
  const blocked = await request(limiter, userB);
  assert.equal(blocked.res.statusCode, 429);
  assert.match(blocked.res.body.error, /shared AI capacity/);
});

integration('a failing budget read fails open', async () => {
  const limiter = createAiLimiter({
    database: { query: async () => { throw new Error('db down'); } },
    maxRequests: 1,
  });
  assert.equal((await request(limiter, userA)).accepted, true);
});
