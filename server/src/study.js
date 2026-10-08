import { readFile } from 'node:fs/promises';
import { HttpError } from './http.js';
import { registerCurriculumRoutes } from './curriculum.js';
import { registerContentReviewRoutes, validatePublishingMetadata } from './content-review.js';
import { courseDetail, courseSummary, emptyProgress, localDate, planSession, rankedConcepts,
  recordAnswer, requireToday, serializeSession, validateDate, validateTimezone } from './study-planner.js';

const courseFile = new URL('../data/course-packs/cardiovascular-foundations.json', import.meta.url);
let cachedPacks;
export async function defaultPacks() {
  // Retry a failed read (e.g. during an atomic deploy), but pin successful loads for this process.
  cachedPacks ??= readFile(courseFile, 'utf8').then((content) => [validatePublishingMetadata(JSON.parse(content))]).catch((error) => {
    cachedPacks = undefined; throw error;
  });
  return cachedPacks;
}

function enrollment(row) {
  return row ? { course_id: row.course_id, daily_minutes: row.daily_minutes,
    exam_date: row.exam_date ?? null, timezone: row.timezone } : null;
}

function assertObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required.');
}

function uuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'Invalid study session ID.');
  }
  return value;
}

function answerBody(step, body) {
  assertObject(body);
  if (step.type === 'lesson') {
    if (Object.keys(body).length) throw new HttpError(400, 'A lesson completion takes an empty JSON object.');
    return { option_index: null, confidence: null };
  }
  if (Object.keys(body).some((key) => !['option_index', 'confidence'].includes(key))) {
    throw new HttpError(400, 'Submit only your chosen option and confidence.');
  }
  if (!Number.isInteger(body.option_index) || body.option_index < 0
    || body.option_index >= step.question_snapshot.options.length) throw new HttpError(400, 'Choose a valid option.');
  const confidence = body.confidence ?? 'okay';
  if (!['unsure', 'okay', 'confident'].includes(confidence)) throw new HttpError(400, 'Choose a valid confidence.');
  return { option_index: body.option_index, confidence };
}

export function createStudyService(database, { now = () => new Date(), loadPacks = defaultPacks } = {}) {
  const { one, many, withTransaction } = database;
  async function packFor(id) {
    const pack = (await loadPacks()).find((candidate) => candidate.id === id);
    if (!pack) throw new HttpError(404, 'Study course not found.');
    return pack;
  }
  const loadEnrollment = (userId) => one(
    'select course_id,daily_minutes,exam_date::text,timezone from study_enrollments where user_id=$1', [userId]);
  async function loadProgress(userId, courseId, client) {
    const sql = 'select concept_id,state from study_concept_progress where user_id=$1 and course_id=$2';
    const rows = client ? (await client.query(sql, [userId, courseId])).rows : await many(sql, [userId, courseId]);
    return Object.fromEntries(rows.map((row) => [row.concept_id, row.state]));
  }
  async function sessionWithAnswers(row, client) {
    const sql = 'select step_id,option_index,confidence,correct,feedback from study_step_answers where session_id=$1 order by answered_at';
    const answers = client ? (await client.query(sql, [row.id])).rows : await many(sql, [row.id]);
    return serializeSession(row, answers);
  }
  const lockUser = (client, userId) => client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`study:${userId}`]);
  async function syllabusConceptIds(userId, courseId, client) {
    const sql = 'select links from syllabus_objectives where user_id=$1 order by position';
    const rows = client ? (await client.query(sql, [userId])).rows : await many(sql, [userId]);
    return [...new Set(rows.flatMap((row) => row.links.filter((link) => link.course_id === courseId).map((link) => link.concept_id)))];
  }
  const event = (client, userId, name, key) => client.query('insert into learning_events(user_id,event_name,event_key) values ($1,$2,$3) on conflict do nothing', [userId, name, key]);

  return {
    async courses() { return (await loadPacks()).map(courseSummary); },
    async course(userId, id) { return courseDetail(await packFor(id), await loadProgress(userId, id)); },
    async enroll(userId, body) {
      assertObject(body);
      if (!Number.isInteger(body.daily_minutes) || body.daily_minutes < 10 || body.daily_minutes > 60) {
        throw new HttpError(400, 'Study time must be a whole number between 10 and 60 minutes.');
      }
      const pack = await packFor(body.course_id);
      const timezone = validateTimezone(body.timezone ?? 'UTC');
      const examDate = body.exam_date == null ? null : validateDate(body.exam_date, 'exam_date');
      if (examDate && examDate < localDate(now(), timezone)) throw new HttpError(400, 'The exam date must be today or later.');
      return withTransaction(async (client) => {
        await lockUser(client, userId);
        const row = (await client.query(`insert into study_enrollments(user_id,course_id,daily_minutes,exam_date,timezone)
          values ($1,$2,$3,$4,$5) on conflict(user_id) do update set course_id=excluded.course_id,
          daily_minutes=excluded.daily_minutes,exam_date=excluded.exam_date,timezone=excluded.timezone,updated_at=now()
          returning course_id,daily_minutes,exam_date::text,timezone`, [userId, pack.id, body.daily_minutes, examDate, timezone])).rows[0];
        await event(client, userId, 'plan_saved', localDate(now(), timezone));
        return enrollment(row);
      });
    },
    async dashboard(userId, requestedDate) {
      const enrolled = await loadEnrollment(userId);
      const currentNow = now();
      const date = enrolled ? requireToday(requestedDate, currentNow, enrolled.timezone) : null;
      if (!enrolled) {
        if (requestedDate !== undefined) validateDate(requestedDate);
        return { enrollment: null, course: null, local_date: null, summary: { total_objectives: 0,
          practiced_objectives: 0, secure_objectives: 0, due_concepts: 0, completed_sessions: 0 },
        today: null, recent_sessions: [], recommended_concepts: [], mistakes: [] };
      }
      const pack = await packFor(enrolled.course_id);
      const progress = await loadProgress(userId, pack.id);
      const course = courseDetail(pack, progress);
      const sessions = await many(`select s.id,s.local_date::text,s.status,s.steps,
          (select count(*)::int from study_step_answers a where a.session_id=s.id) as completed_steps
        from study_sessions s where s.user_id=$1 and s.course_id=$2 order by s.local_date desc,s.created_at desc limit 5`, [userId, pack.id]);
      const present = (row) => ({ id: row.id, local_date: row.local_date, status: row.status,
        completed_steps: row.completed_steps, total_steps: row.steps.length,
        estimated_minutes: row.steps.reduce((sum, step) => sum + step.estimated_minutes, 0) });
      const today = sessions.find((row) => row.local_date === date);
      const completed = await one("select count(*)::int as count from study_sessions where user_id=$1 and course_id=$2 and status='completed'", [userId, pack.id]);
      const mistakes = await many(`select concept_id,concept_title,question,selected_option,correct_option,
        explanation,misconception,confidence,created_at,resolved,sources from study_mistakes
        where user_id=$1 and course_id=$2 order by resolved asc,created_at desc limit 30`, [userId, pack.id]);
      const syllabusIds = await syllabusConceptIds(userId, pack.id);
      const ranked = rankedConcepts(pack, progress, currentNow, syllabusIds);
      return { enrollment: enrollment(enrolled), course, local_date: date,
        summary: { total_objectives: course.concepts.length,
          practiced_objectives: course.concepts.filter((concept) => concept.progress.attempts > 0).length,
          secure_objectives: course.concepts.filter((concept) => concept.progress.status === 'secure').length,
          due_concepts: ranked.filter((entry) => entry.priority < 2).length, completed_sessions: completed.count },
        today: today ? present(today) : null, recent_sessions: sessions.map(present),
        recommended_concepts: ranked.slice(0, 3).map(({ concept, kind, priority }) => ({ id: concept.id,
          title: concept.title, reason: kind === 'repair' ? 'Repair a recent misunderstanding'
            : kind === 'new' ? (syllabusIds.includes(concept.id) ? 'Learn an objective mapped to your syllabus' : 'Learn the next course objective') : priority === 1 ? 'Due for spaced review' : 'Practise a fresh question variant' })),
        mistakes: mistakes.map((mistake) => ({ ...mistake, created_at: new Date(mistake.created_at).toISOString() })) };
    },
    async start(userId, body = {}) {
      assertObject(body);
      return withTransaction(async (client) => {
        await lockUser(client, userId);
        const enrolled = (await client.query('select *,exam_date::text from study_enrollments where user_id=$1', [userId])).rows[0];
        if (!enrolled) throw new HttpError(409, 'Choose a course and study time first.');
        const currentNow = now();
        const date = requireToday(body.date, currentNow, enrolled.timezone);
        const existing = (await client.query('select *,local_date::text from study_sessions where user_id=$1 and course_id=$2 and local_date=$3', [userId, enrolled.course_id, date])).rows[0];
        if (existing) return sessionWithAnswers(existing, client);
        const pack = await packFor(enrolled.course_id);
        const steps = planSession(pack, await loadProgress(userId, pack.id, client), enrolled.daily_minutes, currentNow,
          { examDate: enrolled.exam_date, today: date, syllabusConceptIds: await syllabusConceptIds(userId, pack.id, client) });
        const row = (await client.query(`insert into study_sessions(user_id,course_id,course_title,pack_version,pack_snapshot,
          local_date,timezone,daily_minutes,steps) values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb) returning *,local_date::text`,
        [userId, pack.id, pack.title, pack.version, JSON.stringify(pack), date, enrolled.timezone, enrolled.daily_minutes, JSON.stringify(steps)])).rows[0];
        await event(client, userId, 'session_started', row.id);
        return sessionWithAnswers(row, client);
      });
    },
    async session(userId, id) {
      const row = await one('select *,local_date::text from study_sessions where id=$1 and user_id=$2', [uuid(id), userId]);
      if (!row) throw new HttpError(404, 'Study session not found.');
      return sessionWithAnswers(row);
    },
    async answer(userId, id, stepId, body) {
      uuid(id);
      return withTransaction(async (client) => {
        const row = (await client.query('select *,local_date::text from study_sessions where id=$1 and user_id=$2 for update', [id, userId])).rows[0];
        if (!row) throw new HttpError(404, 'Study session not found.');
        const step = row.steps.find((item) => item.id === stepId);
        if (!step) throw new HttpError(404, 'Study step not found.');
        const input = answerBody(step, body);
        const answers = (await client.query('select * from study_step_answers where session_id=$1', [id])).rows;
        const prior = answers.find((answer) => answer.step_id === stepId);
        if (prior) {
          if (prior.option_index !== input.option_index || prior.confidence !== input.confidence) {
            throw new HttpError(409, 'This step is already complete. The saved answer cannot be changed.');
          }
          return { session: serializeSession(row, answers), feedback: prior.feedback };
        }
        const completedIds = new Set(answers.map((answer) => answer.step_id));
        if (row.steps.find((item) => !completedIds.has(item.id))?.id !== stepId) {
          throw new HttpError(409, 'Complete the current study step first.');
        }
        const currentNow = now();
        await client.query(`insert into study_concept_progress(user_id,course_id,concept_id,state)
          values ($1,$2,$3,$4::jsonb) on conflict do nothing`, [userId, row.course_id, step.concept_id, JSON.stringify(emptyProgress())]);
        const stored = (await client.query('select state from study_concept_progress where user_id=$1 and course_id=$2 and concept_id=$3 for update', [userId, row.course_id, step.concept_id])).rows[0];
        let state = { ...emptyProgress(), ...stored.state };
        let feedback = null;
        let correct = null;
        if (step.type === 'lesson') state.lesson_completed = true;
        else {
          const question = step.question_snapshot;
          correct = input.option_index === question.correct_index;
          feedback = { correct, correct_index: question.correct_index, explanation: question.explanation,
            misconception: correct ? null : question.misconceptions[input.option_index], sources: step.sources };
          state = recordAnswer(state, question.id, correct, input.confidence, currentNow, localDate(currentNow, row.timezone));
          if (!correct) {
            await client.query(`insert into study_mistakes(user_id,course_id,concept_id,question_id,concept_title,question,
              selected_option,correct_option,explanation,misconception,confidence,sources,created_at)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
              on conflict(user_id,course_id,question_id) do update set selected_option=excluded.selected_option,
              question=excluded.question,concept_title=excluded.concept_title,
              correct_option=excluded.correct_option,explanation=excluded.explanation,misconception=excluded.misconception,
              confidence=excluded.confidence,sources=excluded.sources,created_at=excluded.created_at,resolved=false`,
            [userId, row.course_id, step.concept_id, question.id, step.title, question.prompt, question.options[input.option_index],
              question.options[question.correct_index], question.explanation, feedback.misconception, input.confidence, JSON.stringify(step.sources), currentNow]);
          } else if (!state.needs_repair) {
            await client.query('update study_mistakes set resolved=true where user_id=$1 and course_id=$2 and concept_id=$3 and not resolved', [userId, row.course_id, step.concept_id]);
          }
        }
        await client.query('update study_concept_progress set state=$4::jsonb,updated_at=$5 where user_id=$1 and course_id=$2 and concept_id=$3', [userId, row.course_id, step.concept_id, JSON.stringify(state), currentNow]);
        const answer = (await client.query(`insert into study_step_answers(session_id,step_id,option_index,confidence,correct,feedback,answered_at)
          values ($1,$2,$3,$4,$5,$6::jsonb,$7) returning *`, [id, stepId, input.option_index, input.confidence, correct,
          feedback ? JSON.stringify(feedback) : null, currentNow])).rows[0];
        answers.push(answer);
        if (answers.length === row.steps.length) {
          row.status = 'completed'; row.completed_at = currentNow;
          await client.query("update study_sessions set status='completed',completed_at=$2 where id=$1", [id, currentNow]);
          await event(client, userId, 'session_completed', row.id);
        }
        return { session: serializeSession(row, answers), feedback };
      });
    },
  };
}

export function registerStudyRoutes(app, { database, now, loadPacks } = {}) {
  registerCurriculumRoutes(app, { database, loadPacks: loadPacks ?? defaultPacks });
  registerContentReviewRoutes(app, { database, loadPacks: loadPacks ?? defaultPacks });
  const service = createStudyService(database, { now, loadPacks });
  const route = (handler) => async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) {
      if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
      console.error('Study request failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Could not complete this study request. Please try again.' });
    }
  };
  app.get('/api/study/courses', route(() => service.courses()));
  app.get('/api/study/courses/:courseId', route((req) => service.course(req.user.id, req.params.courseId)));
  app.put('/api/study/enrollment', route((req) => service.enroll(req.user.id, req.body)));
  app.get('/api/study/dashboard', route((req) => service.dashboard(req.user.id, req.query.date)));
  app.post('/api/study/sessions', route((req) => service.start(req.user.id, req.body ?? {})));
  app.get('/api/study/sessions/:id', route((req) => service.session(req.user.id, req.params.id)));
  app.post('/api/study/sessions/:id/steps/:stepId', route((req) => service.answer(req.user.id, req.params.id, req.params.stepId, req.body)));
}
