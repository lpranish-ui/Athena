// ============================================================================
// Operator routes — content report triage from the web app.
// ============================================================================
// Access is allow-listed through ADMIN_EMAILS (comma-separated). When the
// variable is unset the routes behave as if they do not exist, and reporter
// identity is never included in list responses.

import { HttpError } from './http.js';

const STATUSES = ['open', 'triaged', 'resolved'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adminEmails(value = process.env.ADMIN_EMAILS) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function registerAdminRoutes(app, { database } = {}) {
  const gate = async (req, res, next) => {
    const allowed = adminEmails();
    if (allowed.size === 0) return res.status(404).json({ error: 'Not found.' });
    try {
      const user = await database.one('select email from users where id = $1', [req.user.id]);
      if (!user || !allowed.has(String(user.email).toLowerCase())) {
        return res.status(403).json({ error: 'This area is for course operators.' });
      }
      next();
    } catch {
      res.status(503).json({ error: 'Could not verify operator access.' });
    }
  };

  const fail = (res, error, fallback) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error('Admin route failed:', error?.message ?? error);
    res.status(status).json({ error: status === 500 ? fallback : error.message });
  };

  app.get('/api/admin/reports', gate, async (req, res) => {
    try {
      const status = req.query?.status;
      if (status !== undefined && !STATUSES.includes(status)) throw new HttpError(400, 'Unknown report status.');
      // course_reports.user_id is intentionally not selected (reporter privacy).
      const rows = await database.many(
        `select id, course_id, pack_version, concept_id, question_id, category, message, status, created_at, updated_at
           from course_reports
          ${status ? 'where status = $1' : ''}
          order by created_at asc
          limit 200`,
        status ? [status] : [],
      );
      res.json({ reports: rows });
    } catch (error) {
      fail(res, error, 'Could not load reports.');
    }
  });

  app.patch('/api/admin/reports/:id', gate, async (req, res) => {
    try {
      if (typeof req.params.id !== 'string' || !UUID_PATTERN.test(req.params.id)) throw new HttpError(404, 'Report not found.');
      const status = req.body?.status;
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Choose open, triaged or resolved.');
      const updated = await database.one(
        `update course_reports set status = $2, updated_at = now()
          where id = $1
          returning id, status, updated_at`,
        [req.params.id, status],
      );
      if (!updated) throw new HttpError(404, 'Report not found.');
      res.json(updated);
    } catch (error) {
      fail(res, error, 'Could not update the report.');
    }
  });
}
