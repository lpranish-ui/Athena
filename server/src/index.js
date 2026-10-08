import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { assertAuthConfigured } from './auth.js';
import { pool, query } from './db.js';
import { createUploadWorker } from './uploads.js';
import { createGenerationWorker } from './jobs.js';

assertAuthConfigured();
const app = createApp();

// Keep the database schema up to date on every boot (every statement is
// idempotent, so new tables roll out automatically with each deploy).
try {
  const schemaSql = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  await query(schemaSql);
  console.log('Database schema is up to date.');
} catch (error) {
  console.error('Schema bootstrap failed:', error instanceof Error ? error.message : error);
  throw error;
}

// Older books predate total_chars; fill it once so library quota sums are accurate.
try {
  const backfill = await query(
    `update books set total_chars = (select coalesce(sum(length(content)), 0) from chapters where chapters.book_id = books.id)
      where total_chars is null`,
  );
  if (backfill.rowCount) console.log(`Library size backfill: ${backfill.rowCount} book(s).`);
} catch (error) {
  console.error('Library size backfill failed:', error instanceof Error ? error.message : error);
}

// In-book search needs the pg_trgm index so ILIKE '%term%' scales to big
// books. Created here (not in schema.sql) so any failure is visible in logs.
try {
  await query('create extension if not exists pg_trgm');
  await query(
    'create index if not exists chapters_content_trgm_idx on chapters using gin (content gin_trgm_ops)',
  );
  // Without fresh stats the planner thinks chapters is tiny and skips the
  // index — analyze right after (cheap; a handful of rows).
  await query('analyze chapters');
  console.log('Search index is ready.');
  const plan = await query(
    "explain select id from chapters where content ilike '%pericarditis%' limit 30",
  );
  console.log('Search plan:', plan.rows.map((row) => row['QUERY PLAN']).join(' | '));
} catch (error) {
  console.error('Search index failed:', error instanceof Error ? error.message : error);
}

// Legacy uploads have no durable bytes. Fail stale legacy work while the
// upload worker resumes sessions backed by PostgreSQL chunks.
try {
  await query(
    `update books
        set status = 'error', status_message = 'The upload was interrupted. Please try again.'
      where status = 'processing'
        and created_at < now() - interval '1 hour'
        and not exists (select 1 from upload_sessions u where u.book_id=books.id and u.status in ('uploading','queued','processing'))`,
  );
} catch (error) {
  console.error('Upload cleanup failed:', error instanceof Error ? error.message : error);
}

const port = Number(process.env.PORT) || 8787;
const worker = createUploadWorker();
worker.start();
const generationWorker = createGenerationWorker();
generationWorker.start();
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Athena API listening on http://0.0.0.0:${port}`);
});

async function shutdown() {
  server.close();
  await worker.stop();
  await generationWorker.stop();
  await pool.end();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
