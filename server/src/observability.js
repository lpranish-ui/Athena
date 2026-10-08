import crypto from 'node:crypto';

/** Log only route templates and operational facts. URLs, bodies, tokens and identity stay out. */
export function requestMonitoring({ logger = console, now = Date.now } = {}) {
  return (req, res, next) => {
    const id = crypto.randomUUID();
    const started = now();
    res.set('X-Request-Id', id);
    req.requestId = id;
    res.once('finish', () => {
      const duration = Math.max(0, now() - started);
      if (res.statusCode >= 500 || duration > 5000) logger.warn(JSON.stringify({ event: 'http_request', request_id: id,
        method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode, duration_ms: duration }));
    });
    next();
  };
}
