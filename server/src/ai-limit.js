// ============================================================================
// AI limiter — persistent per-user budget, shared global budget, and an
// in-memory concurrency guard for AI work on the API.
// ============================================================================
// Budgets derive from the ai_calls usage log (one row per successful provider
// call), so they survive restarts and deploys, include background job
// execution, and cannot be reset by reconnecting. The concurrency guard
// (per-user in-flight requests) is inherently process-local.

import * as defaultDatabase from './db.js';

export function createAiLimiter({
  database = defaultDatabase,
  maxRequests = Number(process.env.AI_REQUESTS_PER_HOUR) || 200,
  maxGlobalRequests = Number(process.env.AI_GLOBAL_REQUESTS_PER_HOUR) || 400,
  maxConcurrent = Number(process.env.AI_CONCURRENT_PER_USER) || 2,
  windowMs = 60 * 60 * 1000,
} = {}) {
  // In-flight requests per user; there are no counters to keep here.
  const users = new Map();
  return async (req, res, next) => {
    // Polling durable generation jobs must not consume the budget.
    if (req.method === 'GET') return next();
    const userId = req.user?.id;
    if (!userId) return next();

    let state = users.get(userId);
    if (!state) {
      state = { active: 0 };
      users.set(userId, state);
    }

    if (state.active >= maxConcurrent) {
      res.set('Retry-After', '5');
      return res.status(429).json({
        error: 'Your other study material is still being generated. Try again in a moment.',
      });
    }

    // Sliding-window budgets counted from the provider-call log so every
    // account and background job shares the same view.
    if (database) {
      try {
        const row = (
          await database.query(
            `select count(*) filter (where user_id = $1)::int as user_count,
                    count(*)::int as global_count
               from ai_calls
              where created_at > now() - ($2::int * interval '1 millisecond')`,
            [userId, windowMs],
          )
        ).rows[0];
        if (row && row.user_count >= maxRequests) {
          res.set('Retry-After', '300');
          return res.status(429).json({
            error: 'You have reached the hourly generation limit. Try again later.',
          });
        }
        if (row && row.global_count >= maxGlobalRequests) {
          res.set('Retry-After', '300');
          return res.status(429).json({
            error: 'Athena is at its shared AI capacity right now. Please try again in a little while.',
          });
        }
      } catch (error) {
        // A budget read must never block studying; failing open is deliberate.
        console.error('AI budget check failed:', error instanceof Error ? error.message : error);
      }
    }

    state.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      if (state.active === 0) users.delete(userId);
    };
    res.once('finish', release);
    // Closing the client connection does not stop the provider request. Keep
    // its slot until the handler finishes, including responses to a closed socket.
    const originalEnd = res.end;
    res.end = function (...args) {
      release();
      return originalEnd.apply(this, args);
    };
    next();
  };
}
