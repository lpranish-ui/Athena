import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';

process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';
const { createApp } = await import('../src/app.js');

const connectionString = process.env.TEST_DATABASE_URL;
let pool;
let admin;
let database;
let server;
let base;
let userId;
let schema;

before(async () => {
  if (!connectionString) return;
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Tests require loopback PostgreSQL.');
  assert.equal(url.pathname, '/athena_test', 'Tests must use the dedicated athena_test database.');
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
  userId = (
    await database.one("insert into users(email,password_hash) values ('sharer@local.test','fixture') returning id")
  ).id;
  const app = createApp({
    database,
    registerAuthentication: () => {},
    authenticate: (req, _res, next) => {
      req.user = { id: req.headers['x-test-user'] ?? userId };
      next();
    },
    aiLimiter: null,
    services: {
      ingestFile: async () => {
        throw new Error('Unauthorized ingestion must not run.');
      },
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (pool) await pool.end();
  if (admin) {
    if (schema) await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  }
});

async function request(route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'x-test-user': userId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function seedBookAndChapter() {
  const book = await database.one(
    "insert into books(title, subject, owner_id, status) values ('Share Test Book', 'General', $1, 'ready') returning id",
    [userId],
  );
  const chapter = await database.one(
    "insert into chapters(book_id, number, title, content) values ($1, 1, 'Chapter One', 'Mitochondria produce ATP.') returning id",
    [book.id],
  );
  return { bookId: book.id, chapterId: chapter.id };
}

test('a quiz set shares to a public link with answers included', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const { bookId, chapterId } = await seedBookAndChapter();
  const set = await database.one(
    "insert into mcq_sets(chapter_id, user_id, title, difficulty) values ($1, $2, 'Shareable Quiz', 'medium') returning id",
    [chapterId, userId],
  );
  await database.query(
    `insert into mcqs(set_id, position, question, options, correct_index, explanation, question_type)
     values ($1, 1, 'What produces ATP?', '["Mitochondria","Nucleus"]'::jsonb, 0, 'Mitochondria make ATP.', 'single_best_answer')`,
    [set.id],
  );

  const created = await request('/api/shares', { method: 'POST', body: { kind: 'set', id: set.id } });
  assert.equal(created.status, 200);
  assert.match(created.body.token, /^[A-Za-z0-9]{14}$/);

  const fetched = await request(`/api/shares/${created.body.token}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.kind, 'set');
  assert.equal(fetched.body.payload.title, 'Shareable Quiz');
  assert.equal(fetched.body.payload.book_title, 'Share Test Book');
  assert.equal(fetched.body.payload.questions.length, 1);
  assert.equal(fetched.body.payload.questions[0].correct_index, 0);
  assert.deepEqual(fetched.body.payload.questions[0].options, ['Mitochondria', 'Nucleus']);

  const unknown = await request('/api/shares/zzzzzzzzzzzzzz');
  assert.equal(unknown.status, 404);
});

test('a review deck shares every card snapshot', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const { bookId } = await seedBookAndChapter();
  await database.query(
    `insert into flashcards(user_id, book_id, front, back)
     values ($1, $2, 'What is ATP?', 'Energy currency'), ($1, $2, 'Powerhouse?', 'Mitochondria')`,
    [userId, bookId],
  );
  const created = await request('/api/shares', { method: 'POST', body: { kind: 'deck', id: bookId } });
  assert.equal(created.status, 200);

  const fetched = await request(`/api/shares/${created.body.token}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.kind, 'deck');
  assert.equal(fetched.body.payload.book_title, 'Share Test Book');
  assert.equal(fetched.body.payload.cards.length, 2);
  assert.equal(fetched.body.payload.cards[0].front, 'What is ATP?');
});

test('a highlight shares with its chapter context', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const { bookId, chapterId } = await seedBookAndChapter();
  const note = await database.one(
    `insert into reader_notes(user_id, book_id, chapter_id, paragraph_index, kind, text)
     values ($1, $2, $3, 4, 'highlight', 'Mitochondria produce ATP.') returning id`,
    [userId, bookId, chapterId],
  );
  const created = await request('/api/shares', { method: 'POST', body: { kind: 'note', id: note.id } });
  assert.equal(created.status, 200);

  const fetched = await request(`/api/shares/${created.body.token}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.kind, 'note');
  assert.equal(fetched.body.payload.text, 'Mitochondria produce ATP.');
  assert.equal(fetched.body.payload.chapter_title, 'Chapter One');
  assert.equal(fetched.body.payload.book_title, 'Share Test Book');
});

test('content that is not yours cannot be shared', async (t) => {
  if (!pool) return t.skip('TEST_DATABASE_URL not set');
  const other = await database.one(
    "insert into users(email, password_hash) values ('other@local.test', 'fixture') returning id",
  );
  const { chapterId } = await seedBookAndChapter();
  const set = await database.one(
    "insert into mcq_sets(chapter_id, user_id, title) values ($1, $2, 'Not Yours') returning id",
    [chapterId, other.id],
  );
  const denied = await request('/api/shares', { method: 'POST', body: { kind: 'set', id: set.id } });
  assert.equal(denied.status, 404);
});
