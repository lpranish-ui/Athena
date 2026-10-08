import { HttpError } from './http.js';

export const STUDY_TRACKS = ['mbbs', 'usmle', 'postgraduate'];
const object = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required.');
};
function text(value, max, label) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label} must be text of at most ${max} characters.`);
  return value.trim() || null;
}
export function preferenceInput(body) {
  object(body);
  if (Object.keys(body).some((key) => !['track', 'goal', 'syllabus_text'].includes(key))) throw new HttpError(400, 'Only track, goal and syllabus text can be saved.');
  if (!STUDY_TRACKS.includes(body.track)) throw new HttpError(400, 'Choose MBBS, USMLE or postgraduate entrance.');
  return { track: body.track, goal: text(body.goal, 160, 'Goal'), syllabus_text: text(body.syllabus_text, 20000, 'Syllabus') };
}
export function parseSyllabus(value) {
  const source = text(value, 20000, 'Syllabus');
  if (!source) throw new HttpError(400, 'Paste at least one learning objective, one per line.');
  const lines = source.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (!lines.length) throw new HttpError(400, 'Paste at least one learning objective, one per line.');
  if (lines.length > 100) throw new HttpError(400, 'Import up to 100 objectives at a time.');
  if (lines.some((line) => line.length > 200)) throw new HttpError(400, 'Keep each objective to 200 characters or fewer.');
  const seen = new Set();
  return lines.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
const STOP_WORDS = new Set('the a an of and to for in on with from describe explain understand discuss identify define learning objective'.split(' '));
const tokens = (value) => new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) ?? []);
export function suggestConcepts(title, concepts) {
  const wanted = tokens(title);
  return concepts.map((concept) => {
    const candidate = tokens(`${concept.concept_title} ${concept.objective}`);
    const overlap = [...wanted].filter((word) => candidate.has(word)).length;
    return { concept, score: wanted.size ? overlap / wanted.size : 0, overlap };
  }).filter((match) => match.overlap >= 1 && match.score >= 0.25)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.concept.concept_id.localeCompare(b.concept.concept_id))
    .slice(0, 3).map(({ concept }) => ({ course_id: concept.course_id, concept_id: concept.concept_id, concept_title: concept.concept_title }));
}
export function mappingInput(body, concepts) {
  object(body);
  if (Object.keys(body).some((key) => key !== 'links') || !Array.isArray(body.links) || body.links.length > 5) throw new HttpError(400, 'Choose up to five course objectives.');
  const unique = new Map();
  for (const link of body.links) {
    object(link);
    if (Object.keys(link).some((key) => !['course_id', 'concept_id'].includes(key))) throw new HttpError(400, 'Only course and concept IDs can be mapped.');
    const concept = concepts.find((item) => item.course_id === link.course_id && item.concept_id === link.concept_id);
    if (!concept) throw new HttpError(400, 'Choose an available course objective.');
    unique.set(`${concept.course_id}:${concept.concept_id}`, { course_id: concept.course_id, concept_id: concept.concept_id });
  }
  return [...unique.values()];
}
const preferences = (row) => ({ track: row?.track ?? 'mbbs', goal: row?.goal ?? null, syllabus_text: row?.syllabus_text ?? null,
  updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null });

export function createCurriculumService(database, { loadPacks } = {}) {
  const { one, many, withTransaction } = database;
  const available = async () => (await loadPacks()).flatMap((pack) => pack.concepts.map((concept) => ({
    course_id: pack.id, concept_id: concept.id, concept_title: concept.title, objective: concept.objective,
  })));
  const lock = (client, userId) => client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`syllabus:${userId}`]);
  async function syllabus(userId) {
    const [concepts, rows, states] = await Promise.all([available(), many('select id,title,links,updated_at from syllabus_objectives where user_id=$1 order by position', [userId]),
      many('select course_id,concept_id,state from study_concept_progress where user_id=$1', [userId])]);
    const items = rows.map((row) => {
      const links = row.links.flatMap((link) => {
        const concept = concepts.find((item) => item.course_id === link.course_id && item.concept_id === link.concept_id);
        if (!concept) return [];
        const state = states.find((item) => item.course_id === link.course_id && item.concept_id === link.concept_id)?.state;
        return [{ ...link, concept_title: concept.concept_title, progress_status: state?.status ?? 'new' }];
      });
      return { id: row.id, title: row.title, links, suggestions: suggestConcepts(row.title, concepts), status: links.length ? 'mapped' : 'unmapped' };
    });
    const mapped = items.filter((item) => item.status === 'mapped').length;
    return { items, available_concepts: concepts, summary: { total: items.length, mapped, unmapped: items.length - mapped },
      updated_at: rows.length ? new Date(Math.max(...rows.map((row) => new Date(row.updated_at).getTime()))).toISOString() : null };
  }
  return {
    async preferences(userId) { return preferences(await one('select * from study_preferences where user_id=$1', [userId])); },
    async savePreferences(userId, body) {
      const input = preferenceInput(body);
      return preferences(await one(`insert into study_preferences(user_id,track,goal,syllabus_text) values ($1,$2,$3,$4)
        on conflict(user_id) do update set track=excluded.track,goal=excluded.goal,syllabus_text=excluded.syllabus_text,updated_at=now() returning *`,
      [userId, input.track, input.goal, input.syllabus_text]));
    },
    syllabus,
    async importSyllabus(userId, body) {
      object(body);
      if (Object.keys(body).some((key) => key !== 'text')) throw new HttpError(400, 'Submit only syllabus text.');
      const titles = parseSyllabus(body.text);
      await withTransaction(async (client) => {
        await lock(client, userId);
        await client.query('delete from syllabus_objectives where user_id=$1', [userId]);
        for (const [position, title] of titles.entries()) await client.query('insert into syllabus_objectives(user_id,position,title) values ($1,$2,$3)', [userId, position, title]);
        await client.query(`insert into study_preferences(user_id,syllabus_text) values ($1,$2) on conflict(user_id)
          do update set syllabus_text=excluded.syllabus_text,updated_at=now()`, [userId, body.text.trim()]);
      });
      return syllabus(userId);
    },
    async map(userId, id, body) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400, 'Invalid syllabus objective.');
      const links = mappingInput(body, await available());
      await withTransaction(async (client) => {
        await lock(client, userId);
        const updated = await client.query('update syllabus_objectives set links=$3::jsonb,updated_at=now() where user_id=$1 and id=$2 returning id', [userId, id, JSON.stringify(links)]);
        if (!updated.rows.length) throw new HttpError(404, 'Syllabus objective not found.');
      });
      return syllabus(userId);
    },
  };
}

export function registerCurriculumRoutes(app, options) {
  const service = createCurriculumService(options.database, options);
  const route = (handler) => async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) {
      if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
      console.error('Curriculum request failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Could not save or load your curriculum. Please try again.' });
    }
  };
  app.get('/api/study/preferences', route((req) => service.preferences(req.user.id)));
  app.put('/api/study/preferences', route((req) => service.savePreferences(req.user.id, req.body)));
  app.get('/api/study/syllabus', route((req) => service.syllabus(req.user.id)));
  app.post('/api/study/syllabus/import', route((req) => service.importSyllabus(req.user.id, req.body)));
  app.put('/api/study/syllabus/:id', route((req) => service.map(req.user.id, req.params.id, req.body)));
}
