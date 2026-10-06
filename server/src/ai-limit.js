/** Bounds concurrent AI work and hourly usage without sending any content elsewhere. */
export function createAiLimiter({
  maxRequests = Number(process.env.AI_REQUESTS_PER_HOUR) || 100,
  maxConcurrent = Number(process.env.AI_CONCURRENT_PER_USER) || 2,
  windowMs = 60 * 60 * 1000,
  now = Date.now,
} = {}) {
  const users = new Map();
  return (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return next();
    const time = now();
    if (users.size > 1000) {
      for (const [id, entry] of users) {
        if (entry.active === 0 && entry.resetAt <= time) users.delete(id);
      }
    }
    let state = users.get(userId);
    if (!state) {
      state = { count: 0, active: 0, resetAt: time + windowMs };
      users.set(userId, state);
    } else if (state.resetAt <= time) {
      state.count = 0;
      state.resetAt = time + windowMs;
    }
    if (state.count >= maxRequests || state.active >= maxConcurrent) {
      const delay = state.active >= maxConcurrent ? 5 : Math.ceil((state.resetAt - time) / 1000);
      res.set('Retry-After', String(Math.max(1, delay)));
      return res.status(429).json({
        error: state.active >= maxConcurrent
          ? 'Your other study material is still being generated. Try again in a moment.'
          : 'You have reached the hourly generation limit. Try again later.',
      });
    }
    state.count += 1;
    state.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
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
