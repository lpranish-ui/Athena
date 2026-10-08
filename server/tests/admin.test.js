import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import pg from 'pg';

process.env.JWT_SECRET ||= 'local-test-secret-not-for-production';
const { createApp } = await import('../src/app.js');
const connectionString = process.env.TEST_DATABASE_URL;
let pool, admin, database, server, base, userA, userB, schema;
let savedAdminEmails;

before(async () => {
  if (!connectionString) return;
  savedAdminEmails = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
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
  userA = (await database.one("insert into users(email,password_hash) values ('admin-a@test.local','fixture') returning id")).id;
  userB = (await database.one("insert into users(email,password_hash) values ('admin-b@test.local','fixture') returning id")).id;
  const app = createApp({ database, registerAuthentication: () => {}, aiLimiter: null,
    authenticate: (req, _res, next) => { req.user = { id: req.headers['x-test-user'] ?? userA }; next(); } });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = savedAdminEmails;
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

integration('operator routes stay hidden until ADMIN_EMAILS is configured', async () => {
  delete process.env.ADMIN_EMAILS;
  assert.equal((await request('/api/admin/reports')).status, 404);
  process.env.ADMIN_EMAILS = 'admin-a@test.local';
});

integration('operator access requires a listed email', async () => {
  assert.equal((await request('/api/admin/reports', { user: userB })).status, 403);
  const allowed = await request('/api/admin/reports');
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.reports, []);
});

integration('reports list excludes reporter identity and triage updates status', async () => {
  const report = await database.one(
    `insert into course_reports (user_id, course_id, pack_version, concept_id, question_id, category, message)
     values ($1, 'cardiovascular-foundations', 'test-1', 'flow', null, 'accuracy', 'The stated pressure gradient looks wrong.')
     returning id`,
    [userB],
  );

  const listed = await request('/api/admin/reports?status=open');
  assert.equal(listed.status, 200);
  const entry = listed.body.reports.find((row) => row.id === report.id);
  assert.ok(entry, 'the open report must be listed');
  assert.equal(entry.message, 'The stated pressure gradient looks wrong.');
  assert.ok(!('user_id' in entry), 'reporter identity must not leak');
  assert.ok(!('email' in entry));

  assert.equal((await request('/api/admin/reports?status=nonsense')).status, 400);
  assert.equal((await request(`/api/admin/reports/${report.id}`, { method: 'PATCH', body: { status: 'archived' } })).status, 400);
  assert.equal((await request(`/api/admin/reports/${crypto.randomUUID()}`, { method: 'PATCH', body: { status: 'triaged' } })).status, 404);
  assert.equal((await request('/api/admin/reports/not-a-uuid', { method: 'PATCH', body: { status: 'triaged' } })).status, 404);

  const updated = await request(`/api/admin/reports/${report.id}`, { method: 'PATCH', body: { status: 'triaged' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'triaged');
  const open = await request('/api/admin/reports?status=open');
  assert.ok(!open.body.reports.some((row) => row.id === report.id), 'triaged reports leave the open queue');
});
