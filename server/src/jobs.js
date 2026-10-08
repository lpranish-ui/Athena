// ============================================================================
// Durable generation jobs — quiz sets and study material are produced by a
// background worker, so a closed app or dropped connection never loses work.
// ============================================================================
// Mirrors the upload worker: PostgreSQL rows are the queue, one job is leased
// at a time, a heartbeat keeps long runs alive, and transient failures retry
// once. The app polls /api/ai/jobs/:id for stage text and the final result.

import crypto from 'node:crypto';

import * as defaultDatabase from './db.js';
import { generateMcqs as defaultGenerateMcqs } from './generate.js';
import { HttpError } from './http.js';
import { generateStudyKit as defaultGenerateStudyKit } from './studykit.js';

const MAX_ACTIVE_JOBS_PER_USER = 3;
const MAX_CHAPTERS_PER_JOB = 8;
const JOB_RETENTION_DAYS = 7;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(kind, input) {
  if (kind === 'mcqs') {
    const chapterIds = Array.isArray(input?.chapterIds)
      ? [...new Set(input.chapterIds.filter((id) => typeof id === 'string' && id.length > 0))]
      : [];
    if (chapterIds.length === 0) throw new HttpError(400, 'Choose at least one chapter.');
    if (chapterIds.length > MAX_CHAPTERS_PER_JOB) {
      throw new HttpError(400, `Choose at most ${MAX_CHAPTERS_PER_JOB} chapters per quiz.`);
    }
    if (input.count != null && !Number.isInteger(input.count)) throw new HttpError(400, 'count must be an integer.');
    return {
      chapterIds,
      ...(input.count != null ? { count: input.count } : {}),
      ...(typeof input.difficulty === 'string' ? { difficulty: input.difficulty } : {}),
      ...(typeof input.questionType === 'string' ? { questionType: input.questionType } : {}),
      ...(typeof input.addToSetId === 'string' && input.addToSetId
        ? { addToSetId: input.addToSetId }
        : {}),
    };
  }

  const material = input?.material === 'summary' || input?.material === 'flashcards' ? input.material : null;
  if (typeof input?.chapterId !== 'string' || input.chapterId.length === 0 || !material) {
    throw new HttpError(400, 'chapterId and a valid material kind are required.');
  }
  if (input.count != null && !Number.isInteger(input.count)) throw new HttpError(400, 'count must be an integer.');
  return {
    chapterId: input.chapterId,
    material,
    ...(input.count != null ? { count: input.count } : {}),
  };
}

function publicJob(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    error: row.status === 'failed' ? row.error : null,
    result: row.status === 'done' ? row.result : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createGenerationService(database = defaultDatabase) {
  return {
    async create(userId, kind, input) {
      if (kind !== 'mcqs' && kind !== 'study_kit') {
        throw new HttpError(400, 'Unknown generation type.');
      }
      const payload = validatePayload(kind, input ?? {});
      return database.withTransaction(async (client) => {
        // Serialize per-user quota checks so parallel taps cannot exceed the cap.
        await client.query('select id from users where id = $1 for update', [userId]);
        const active =
          (await client.query(
            `select count(*)::int as count from generation_jobs
              where user_id = $1 and status in ('queued','running')`,
            [userId],
          )).rows[0]?.count ?? 0;
        if (active >= MAX_ACTIVE_JOBS_PER_USER) {
          throw new HttpError(429, 'You already have study material being generated. Wait for it to finish, then try again.');
        }
        const job = (
          await client.query(
            `insert into generation_jobs (user_id, kind, payload)
             values ($1, $2, $3::jsonb)
             returning id, status, stage, created_at`,
            [userId, kind, JSON.stringify(payload)],
          )
        ).rows[0];
        return { jobId: job.id, status: job.status, stage: job.stage, createdAt: job.created_at };
      });
    },

    async get(userId, jobId) {
      if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) throw new HttpError(404, 'Job not found.');
      const row = await database.one('select * from generation_jobs where id = $1 and user_id = $2', [jobId, userId]);
      if (!row) throw new HttpError(404, 'Job not found.');
      return publicJob(row);
    },

    async list(userId, { active = false } = {}) {
      const rows = await database.many(
        `select * from generation_jobs
          where user_id = $1 ${active ? "and status in ('queued','running')" : ''}
          order by created_at desc
          limit 20`,
        [userId],
      );
      return rows.map(publicJob);
    },
  };
}

export function registerGenerationRoutes(app, { database = defaultDatabase } = {}) {
  const service = createGenerationService(database);
  const wrap = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('generation job route failed:', error?.message ?? error);
      res.status(status).json({
        error: status === 500 ? 'Could not start the generation. Please try again.' : error.message,
      });
    }
  };
  app.post('/api/ai/jobs', wrap(async (req, res) => {
    const { kind, ...input } = req.body ?? {};
    res.status(202).json(await service.create(req.user.id, kind, input));
  }));
  app.get('/api/ai/jobs', wrap(async (req, res) => {
    res.json({ jobs: await service.list(req.user.id, { active: req.query?.active === '1' }) });
  }));
  app.get('/api/ai/jobs/:id', wrap(async (req, res) => {
    res.json(await service.get(req.user.id, req.params.id));
  }));
}

/** Runs one job by kind. Injected in tests. */
export async function defaultExecute({ userId, kind, payload, onStage }) {
  if (kind === 'mcqs') return defaultGenerateMcqs({ userId, body: payload, onStage });
  return defaultGenerateStudyKit({
    userId,
    chapterId: payload.chapterId,
    kind: payload.material,
    ...(payload.count != null ? { count: payload.count } : {}),
    onStage,
  });
}

export function createGenerationWorker({
  database = defaultDatabase,
  execute = defaultExecute,
  intervalMs = 1500,
  leaseMs = 10 * 60 * 1000,
  maxAttempts = 2,
} = {}) {
  let running = false;
  let stopped = false;
  let timer;
  let lastCleanup = 0;
  let activeTask;

  async function cleanup() {
    await database
      .query(
        `delete from generation_jobs
          where status in ('done','failed') and updated_at < now() - ($1::int * interval '1 day')`,
        [JOB_RETENTION_DAYS],
      )
      .catch(() => {});
    // Keep the provider-call log bounded; AI budgets only need the recent window.
    await database
      .query(`delete from ai_calls where created_at < now() - interval '90 days'`)
      .catch(() => {});
  }

  async function runOnce() {
    if (running || stopped) return false;
    running = true;
    let lease;
    let heartbeat;
    try {
      if (Date.now() - lastCleanup > 60 * 60 * 1000) {
        lastCleanup = Date.now();
        await cleanup();
      }
      lease = await database.withTransaction(async (client) => {
        const job = (
          await client.query(
            `select * from generation_jobs
              where status = 'queued'
                 or (status = 'running' and lease_at < now() - ($1::int * interval '1 millisecond'))
              order by created_at
              for update skip locked
              limit 1`,
            [leaseMs],
          )
        ).rows[0];
        if (!job) return null;
        if (job.attempts >= maxAttempts) {
          await client.query(
            `update generation_jobs
                set status = 'failed', stage = 'Did not finish', error = $2,
                    lease_token = null, lease_at = null, updated_at = now()
              where id = $1`,
            [job.id, 'Generation was interrupted before it could finish. Please try again.'],
          );
          return null;
        }
        const token = crypto.randomUUID();
        await client.query(
          `update generation_jobs
              set status = 'running', stage = 'Starting…', attempts = attempts + 1,
                  lease_token = $2, lease_at = now(), error = null, updated_at = now()
            where id = $1`,
          [job.id, token],
        );
        return { ...job, token };
      });
      if (!lease) return false;

      const updateStage = async (note) => {
        try {
          await database.query(
            `update generation_jobs set stage = $2, updated_at = now()
              where id = $1 and lease_token = $3 and status = 'running'`,
            [lease.id, String(note).slice(0, 120), lease.token],
          );
        } catch {
          // Progress updates are best-effort and never fail the job.
        }
      };

      heartbeat = setInterval(() => {
        void database
          .query(
            `update generation_jobs set lease_at = now()
              where id = $1 and lease_token = $2 and status = 'running'`,
            [lease.id, lease.token],
          )
          .catch(() => {});
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();

      const result = await execute({
        userId: lease.user_id,
        kind: lease.kind,
        payload: lease.payload,
        onStage: updateStage,
      });

      await database.query(
        `update generation_jobs
            set status = 'done', stage = 'Ready', result = $2::jsonb, error = null,
                lease_token = null, lease_at = null, updated_at = now()
          where id = $1 and lease_token = $3`,
        [lease.id, JSON.stringify(result ?? {}), lease.token],
      );
      return true;
    } catch (error) {
      console.error('Durable generation job failed:', error?.message ?? error);
      if (lease) {
        // Validation-style failures are final; infrastructure hiccups retry once.
        const permanent = error instanceof HttpError;
        const retry = !permanent && Number(lease.attempts) + 1 < maxAttempts;
        await database
          .query(
            `update generation_jobs
                set status = $3, stage = $4, error = $5,
                    lease_token = null, lease_at = null, updated_at = now()
              where id = $1 and lease_token = $2`,
            [
              lease.id,
              lease.token,
              retry ? 'queued' : 'failed',
              retry ? 'Retrying…' : 'Did not finish',
              error instanceof HttpError ? error.message : 'Generation failed. Please try again.',
            ],
          )
          .catch(() => {});
      }
      return false;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      running = false;
    }
  }

  return {
    runOnce,
    start() {
      if (timer || stopped) return;
      activeTask = runOnce();
      timer = setInterval(() => {
        if (!running) activeTask = runOnce();
      }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await activeTask;
    },
  };
}
