import { HttpError } from './http.js';

/** Publishing checks validate provenance fields; they cannot substitute for editorial review. */
export function validatePublishingMetadata(pack) {
  if (!pack || !['draft', 'reviewed'].includes(pack.review_status)) throw new Error('A course pack needs an explicit draft or reviewed status.');
  if (typeof pack.review_note !== 'string' || !pack.review_note.trim()) throw new Error('A course pack needs a visible review note.');
  if (pack.review_status === 'reviewed') {
    if (typeof pack.reviewed_by !== 'string' || !pack.reviewed_by.trim()) throw new Error('Reviewed packs must name their reviewer.');
    if (typeof pack.reviewed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(pack.reviewed_at)
      || !Number.isFinite(Date.parse(pack.reviewed_at)) || new Date(pack.reviewed_at).toISOString().slice(0, 10) !== pack.reviewed_at) throw new Error('Reviewed packs must include a valid review date.');
    if (pack.reviewed_at > new Date().toISOString().slice(0, 10)) throw new Error('A review date cannot be in the future.');
  }
  if (pack.rights?.commercial_distribution !== 'original_content' && pack.rights?.commercial_distribution !== 'licensed_content') throw new Error('A course pack needs commercial distribution provenance.');
  if (!Array.isArray(pack.concepts) || !pack.concepts.length) throw new Error('A course pack needs learning objectives.');
  return pack;
}

export function reportInput(body, pack) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required.');
  if (Object.keys(body).some((key) => !['course_id', 'concept_id', 'question_id', 'session_id', 'category', 'message'].includes(key))) throw new HttpError(400, 'Only the content location, category and message can be reported.');
  const concept = pack?.concepts.find((item) => item.id === body.concept_id);
  if (!concept) throw new HttpError(404, 'Course objective not found.');
  const question = body.question_id ?? null;
  if (question !== null && !concept.questions.some((item) => item.id === question)) throw new HttpError(400, 'Choose a question in this objective.');
  if (!['accuracy', 'source', 'unclear', 'other'].includes(body.category)) throw new HttpError(400, 'Choose a report category.');
  if (typeof body.message !== 'string' || body.message.trim().length < 10 || body.message.length > 2000) throw new HttpError(400, 'Describe the issue in 10 to 2000 characters.');
  return { concept_id: concept.id, question_id: question, category: body.category, message: body.message.trim() };
}

export function registerContentReviewRoutes(app, { database, loadPacks }) {
  app.post('/api/study/reports', async (req, res) => {
    try {
      let pack;
      if (req.body?.session_id != null) {
        if (typeof req.body.session_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.session_id)) throw new HttpError(400, 'Invalid study session.');
        const saved = await database.one('select pack_snapshot from study_sessions where id=$1 and user_id=$2 and course_id=$3', [req.body.session_id, req.user.id, req.body.course_id]);
        if (!saved) throw new HttpError(404, 'Study session not found.');
        pack = saved.pack_snapshot;
      } else pack = (await loadPacks()).find((item) => item.id === req.body?.course_id);
      if (!pack) throw new HttpError(404, 'Study course not found.');
      const input = reportInput(req.body, pack);
      const report = await database.withTransaction(async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`reports:${req.user.id}`]);
        const { count } = (await client.query("select count(*)::int as count from course_reports where user_id=$1 and created_at>now()-interval '24 hours'", [req.user.id])).rows[0];
        if (count >= 20) throw new HttpError(429, 'You have submitted 20 reports today. Please try again tomorrow.');
        return (await client.query(`insert into course_reports(user_id,course_id,pack_version,concept_id,question_id,category,message)
          values ($1,$2,$3,$4,$5,$6,$7) returning id,status,created_at`, [req.user.id, pack.id, pack.version,
        input.concept_id, input.question_id, input.category, input.message])).rows[0];
      });
      res.status(201).json(report);
    } catch (error) {
      if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
      console.error('Content report failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Could not submit this report. Please try again.' });
    }
  });
  app.get('/api/study/reports', async (req, res) => {
    try { res.json(await database.many('select id,course_id,concept_id,question_id,category,status,created_at from course_reports where user_id=$1 order by created_at desc limit 30', [req.user.id])); }
    catch { res.status(503).json({ error: 'Could not load your reports. Please try again.' }); }
  });
}
