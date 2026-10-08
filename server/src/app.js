import cors from 'cors';
import express from 'express';
import { createAiLimiter } from './ai-limit.js';
import { answerQuestion as defaultAnswerQuestion } from './ask.js';
import { registerAuthRoutes, createRequireAuth } from './auth.js';
import { createChapterService } from './chapters.js';
import * as defaultDatabase from './db.js';
import { generateMcqs as defaultGenerateMcqs, replaceQuestion as defaultReplaceQuestion } from './generate.js';
import { registerGroupRoutes } from './group.js';
import { HttpError } from './http.js';
import { IngestError, ingestFile as defaultIngestFile, ingestText as defaultIngestText } from './ingest.js';
import { summarizeProgress, summarizeStreak } from './progress.js';
import { registerPublicShareRoutes, registerShareRoutes } from './shares.js';
import { generateStudyKit as defaultGenerateStudyKit } from './studykit.js';
import { registerStudyRoutes } from './study.js';
import { registerUploadRoutes } from './uploads.js';
import { registerGenerationRoutes } from './jobs.js';
import { requestMonitoring } from './observability.js';
import { registerAdminRoutes } from './admin.js';

/** Construct routes without connecting to a database or opening a listening socket. */
export function createApp({ database = defaultDatabase, authenticate = createRequireAuth(database),
  registerAuthentication = registerAuthRoutes, services = {}, aiLimiter = createAiLimiter({ database }) } = {}) {
  const { query, one, many, withTransaction } = database;
  const app = express();
  const chapterService = createChapterService(database);
  const answerQuestion = services.answerQuestion ?? defaultAnswerQuestion;
  const generateMcqs = services.generateMcqs ?? defaultGenerateMcqs;
  const replaceQuestion = services.replaceQuestion ?? defaultReplaceQuestion;
  const generateStudyKit = services.generateStudyKit ?? defaultGenerateStudyKit;
  const ingestText = services.ingestText ?? defaultIngestText;
  const ingestFile = services.ingestFile ?? defaultIngestFile;

  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.use(cors());
  app.use(requestMonitoring());
  app.use(express.json({ limit: '4mb' }));

  // Health check (used by Render).
  app.get('/api/health', async (_req, res) => {
    try {
      await query('select 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Public auth routes.
  registerAuthentication(app, { database });

  // Public share links (read-only snapshots) — must precede the auth gate.
  registerPublicShareRoutes(app, { database });

  // Everything else under /api requires a signed-in user.
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path === '/health') {
      next();
      return;
    }
    authenticate(req, res, next);
  });

  // Multiplayer group-study routes (a signed-in user is required).
  registerGroupRoutes(app, { database });
  registerUploadRoutes(app, { database });
  registerShareRoutes(app, { database });
  registerStudyRoutes(app, { database, now: services.studyNow, loadPacks: services.studyPacks });
  if (aiLimiter) {
    app.use('/api/ai', aiLimiter);
    app.use('/api/books/:id/ask', aiLimiter);
  }
  // Registered after the limiter so new jobs count against the hourly budget
  // (status polling is exempted by method inside the limiter).
  registerGenerationRoutes(app, { database });
  // Operator-only content report triage (off unless ADMIN_EMAILS is set).
  registerAdminRoutes(app, { database });

  /** Sends a thrown error with the right status and a `{ error }` body. */
  function handle(res, error, fallback) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(fallback, error instanceof Error ? error.message : error);
    res.status(500).json({ error: fallback });
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  /** Loads a book the user may read (built-in or their own); null when not. */
  function readableBook(bookId, userId) {
    return one('select * from books where id = $1 and (is_default or owner_id = $2)', [bookId, userId]);
  }

  /** Loads an owned book; throws 404/403 when not accessible. */
  async function ownedBook(bookId, userId) {
    const book = await one('select * from books where id = $1', [bookId]);
    if (!book) throw new HttpError(404, 'Book not found.');
    if (book.owner_id !== userId) throw new HttpError(403, 'You can only change your own books.');
    return book;
  }

  /** Loads a chapter the user may read (via its book); null when not. */
  function readableChapter(chapterId, userId) {
    return one(
      `select c.* from chapters c
         join books b on b.id = c.book_id
        where c.id = $1 and (b.is_default or b.owner_id = $2)`,
      [chapterId, userId],
    );
  }

  /** Loads an owned chapter; throws when not accessible. */
  async function ownedChapter(chapterId, userId) {
    const chapter = await one(
      'select c.*, b.owner_id as book_owner_id from chapters c join books b on b.id = c.book_id where c.id = $1',
      [chapterId],
    );
    if (!chapter) throw new HttpError(404, 'Chapter not found.');
    if (chapter.book_owner_id !== userId) throw new HttpError(403, 'You can only change your own chapters.');
    return chapter;
  }

  async function ownedSet(setId, userId) {
    const set = await one('select * from mcq_sets where id = $1', [setId]);
    if (!set) throw new HttpError(404, 'Quiz not found.');
    if (set.user_id !== userId) throw new HttpError(403, 'This quiz belongs to another account.');
    return set;
  }

  /** Sequential number = 1..n for the given chapter ids (in order). */
  async function renumberChapters(client, ids) {
    for (let index = 0; index < ids.length; index++) {
      await client.query('update chapters set number = $2 where id = $1', [ids[index], index + 1]);
    }
  }

  // ── profile ──────────────────────────────────────────────────────────────────

  app.get('/api/profile', async (req, res) => {
    try {
      const profile = await one('select * from profiles where id = $1', [req.user.id]);
      res.json(profile);
    } catch (error) {
      handle(res, error, 'Could not load your profile.');
    }
  });

  // ── books ────────────────────────────────────────────────────────────────────

  app.get('/api/books', async (req, res) => {
    try {
      const rows = await many(
        `select b.*,
                (select count(*)::int from chapters c where c.book_id = b.id) as chapter_count
           from books b
          where b.is_default or b.owner_id = $1
          order by b.is_default desc, b.created_at desc`,
        [req.user.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load the library.');
    }
  });

  app.post('/api/books', async (req, res) => {
    try {
      const title = String(req.body?.title ?? '').trim();
      if (!title) throw new HttpError(400, 'A title is required.');
      const subject = String(req.body?.subject ?? '').trim() || 'General';
      const author = String(req.body?.author ?? '').trim() || null;
      const fileType = ['pdf', 'epub', 'txt'].includes(req.body?.file_type) ? req.body.file_type : null;

      const book = await one(
        `insert into books (title, subject, author, owner_id, is_default, status, file_type)
         values ($1, $2, $3, $4, false, 'processing', $5)
         returning *`,
        [title, subject, author, req.user.id, fileType],
      );
      res.status(201).json(book);
    } catch (error) {
      handle(res, error, 'Could not create the book.');
    }
  });

  app.get('/api/books/:id', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');
      res.json(book);
    } catch (error) {
      handle(res, error, 'Could not load the book.');
    }
  });

  app.patch('/api/books/:id', async (req, res) => {
    try {
      await ownedBook(req.params.id, req.user.id);
      const allowed = ['title', 'subject', 'author', 'status', 'status_message', 'file_path'];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (key in (req.body ?? {})) {
          values.push(req.body[key]);
          sets.push(`${key} = $${values.length}`);
        }
      }
      if (sets.length === 0) throw new HttpError(400, 'Nothing to update.');
      values.push(req.params.id);
      const updated = await one(
        `update books set ${sets.join(', ')} where id = $${values.length} returning *`,
        values,
      );
      res.json(updated);
    } catch (error) {
      handle(res, error, 'Could not update the book.');
    }
  });

  app.delete('/api/books/:id', async (req, res) => {
    try {
      await ownedBook(req.params.id, req.user.id);
      // Chapters, quiz sets, attempts and study material cascade away with it.
      await query('delete from books where id = $1', [req.params.id]);
      // An in-progress upload for this book is no longer needed.
      // Durable sessions and chunks cascade with the book.
      res.json({ ok: true });
    } catch (error) {
      handle(res, error, 'Could not delete the book.');
    }
  });

  app.get('/api/books/:id/chapters', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');
      const rows = await many(
        `select c.id, c.book_id, c.number, c.title, c.first_page, c.last_page, c.created_at,
                (select count(*)::int
                   from mcq_sets s
                  where s.user_id = $2 and (s.chapter_id = c.id or c.id = any(s.chapter_ids))) as set_count
           from chapters c
          where c.book_id = $1
          order by c.number`,
        [req.params.id, req.user.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load the chapters.');
    }
  });

  // ── chapters ─────────────────────────────────────────────────────────────────

  app.get('/api/chapters/:id', async (req, res) => {
    try {
      const chapter = await one(
        `select c.*, b.title as book_title, b.subject as book_subject
           from chapters c
           join books b on b.id = c.book_id
          where c.id = $1 and (b.is_default or b.owner_id = $2)`,
        [req.params.id, req.user.id],
      );
      if (!chapter) throw new HttpError(404, 'Chapter not found.');
      res.json({
        ...chapter,
        book: { id: chapter.book_id, title: chapter.book_title, subject: chapter.book_subject },
      });
    } catch (error) {
      handle(res, error, 'Could not load the chapter.');
    }
  });

  app.post('/api/chapters', async (req, res) => {
    try {
      const body = req.body ?? {};
      const bookId = String(body.book_id ?? '');
      const title = String(body.title ?? '').trim();
      const content = String(body.content ?? '').trim();
      if (!bookId || !title || !content) {
        throw new HttpError(400, 'book_id, title and content are required.');
      }
      await ownedBook(bookId, req.user.id);

      const last = await one(
        'select max(number) as max from chapters where book_id = $1',
        [bookId],
      );
      const number = Number.isInteger(body.number) ? body.number : (last?.max ?? 0) + 1;

      const chapter = await one(
        `insert into chapters (book_id, number, title, content, page_map, first_page, last_page)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         returning *`,
        [
          bookId,
          number,
          title,
          content,
          body.page_map ? JSON.stringify(body.page_map) : null,
          body.first_page ?? null,
          body.last_page ?? null,
        ],
      );
      res.status(201).json(chapter);
    } catch (error) {
      handle(res, error, 'Could not create the chapter.');
    }
  });

  app.put('/api/chapters/:id', async (req, res) => {
    try {
      await ownedChapter(req.params.id, req.user.id);
      const allowed = ['title', 'content', 'number', 'first_page', 'last_page'];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (key in (req.body ?? {})) {
          values.push(req.body[key]);
          sets.push(`${key} = $${values.length}`);
        }
      }
      if ('page_map' in (req.body ?? {})) {
        values.push(req.body.page_map ? JSON.stringify(req.body.page_map) : null);
        sets.push(`page_map = $${values.length}::jsonb`);
      }
      if (sets.length === 0) throw new HttpError(400, 'Nothing to update.');
      values.push(req.params.id);
      const updated = await one(
        `update chapters set ${sets.join(', ')} where id = $${values.length} returning *`,
        values,
      );
      res.json(updated);
    } catch (error) {
      handle(res, error, 'Could not update the chapter.');
    }
  });

  app.delete('/api/chapters/:id', async (req, res) => {
    try { res.json(await chapterService.remove(req.params.id, req.user.id)); }
    catch (error) { handle(res, error, 'Could not delete the chapter.'); }
  });

  app.post('/api/chapters/:id/split', async (req, res) => {
    try { res.json(await chapterService.split(req.params.id, req.user.id, req.body?.cut)); }
    catch (error) { handle(res, error, 'Could not split the chapter.'); }
  });

  /** Saves a new chapter order after a drag/hand edit (ids in display order). */
  app.post('/api/chapters/renumber', async (req, res) => {
    try {
      const bookId = String(req.body?.book_id ?? '');
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === 'string') : [];
      if (!bookId || ids.length === 0) throw new HttpError(400, 'book_id and ids are required.');
      await ownedBook(bookId, req.user.id);

      const owned = await many('select id from chapters where book_id = $1', [bookId]);
      const ownedIds = new Set(owned.map((row) => row.id));
      if (!ids.every((id) => ownedIds.has(id))) {
        throw new HttpError(400, 'One of the chapters does not belong to this book.');
      }

      await withTransaction((client) => renumberChapters(client, ids));
      res.json({ ok: true });
    } catch (error) {
      handle(res, error, 'Could not save the chapter order.');
    }
  });

  /**
   * Merges a chapter into another one: content is appended, page maps are
   * offset, quizzes are re-pointed (so they survive), the source is removed and
   * the book is renumbered.
   */
  app.post('/api/chapters/:id/merge', async (req, res) => {
    try { res.json(await chapterService.merge(req.params.id, req.user.id, String(req.body?.intoId ?? ''))); }
    catch (error) { handle(res, error, 'Could not merge the chapters.'); }
  });

  /** Lists the user's quizzes with chapter/book context + their attempts. */
  app.get('/api/sets', async (req, res) => {
    try {
      const sets = await many(
        `select s.id, s.chapter_id, s.chapter_ids, s.user_id, s.title, s.difficulty, s.status, s.created_at,
                c.title as chapter_title, c.number as chapter_number,
                b.id as book_id, b.title as book_title, b.subject as book_subject,
                (select count(*)::int from mcqs m where m.set_id = s.id) as question_count
           from mcq_sets s
           left join chapters c on c.id = s.chapter_id
           left join books b on b.id = c.book_id
          where s.user_id = $1
          order by s.created_at desc`,
        [req.user.id],
      );
      const attempts = await many(
        `select id, set_id, score, total, completed_at
           from quiz_attempts
          where user_id = $1
          order by completed_at desc`,
        [req.user.id],
      );
      const bySet = new Map();
      for (const attempt of attempts) {
        const list = bySet.get(attempt.set_id) ?? [];
        list.push({ id: attempt.id, score: attempt.score, total: attempt.total, completed_at: attempt.completed_at });
        bySet.set(attempt.set_id, list);
      }

      res.json(
        sets.map((set) => ({
          ...set,
          chapter:
            set.chapter_title !== null
              ? {
                  id: set.chapter_id,
                  title: set.chapter_title,
                  number: set.chapter_number,
                  book: set.book_id ? { id: set.book_id, title: set.book_title, subject: set.book_subject } : null,
                }
              : null,
          attempts: bySet.get(set.id) ?? [],
        })),
      );
    } catch (error) {
      handle(res, error, 'Could not load your quizzes.');
    }
  });

  /** One quiz with its questions and the student's flagged question ids. */
  app.get('/api/sets/:id', async (req, res) => {
    try {
      const set = await ownedSet(req.params.id, req.user.id);
      const [mcqs, flags, chapters] = await Promise.all([
        many('select * from mcqs where set_id = $1 order by position, created_at', [set.id]),
        many('select question_id from flags where user_id = $1 and question_id = any($2::uuid[])', [
          req.user.id,
          (await many('select id from mcqs where set_id = $1', [set.id])).map((row) => row.id),
        ]),
        set.chapter_ids && set.chapter_ids.length > 0
          ? many(
              `select c.id, c.title, c.number, b.id as book_id, b.title as book_title, b.subject as book_subject
                 from chapters c join books b on b.id = c.book_id
                where c.id = any($1::uuid[])`,
              [set.chapter_ids],
            )
          : [],
      ]);

      res.json({
        set,
        mcqs,
        flaggedIds: flags.map((row) => row.question_id),
        chapters: chapters.map((row) => ({
          id: row.id,
          title: row.title,
          number: row.number,
          book: { id: row.book_id, title: row.book_title, subject: row.book_subject },
        })),
      });
    } catch (error) {
      handle(res, error, 'Could not load the quiz.');
    }
  });

  /** Creates an empty quiz (used by the mock-exam builder). */
  app.post('/api/sets', async (req, res) => {
    try {
      const body = req.body ?? {};
      const title = String(body.title ?? '').trim() || 'Practice quiz';
      const difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium';
      const chapterIds = Array.isArray(body.chapter_ids)
        ? body.chapter_ids.filter((id) => typeof id === 'string')
        : [];
      for (const chapterId of new Set(chapterIds)) {
        if (!(await readableChapter(chapterId,req.user.id))) throw new HttpError(404, 'Chapter not found.');
      }
      const firstChapterId = chapterIds[0] ?? null;

      const set = await one(
        `insert into mcq_sets (chapter_id, chapter_ids, user_id, title, difficulty, status)
         values ($1, $2::uuid[], $3, $4, $5, 'ready') returning *`,
        [firstChapterId, chapterIds.length > 0 ? chapterIds : null, req.user.id, title, difficulty],
      );
      res.status(201).json(set);
    } catch (error) {
      handle(res, error, 'Could not create the quiz.');
    }
  });

  app.delete('/api/sets/:id', async (req, res) => {
    try {
      await ownedSet(req.params.id, req.user.id);
      await query('delete from mcq_sets where id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (error) {
      handle(res, error, 'Could not delete the quiz.');
    }
  });

  /** Appends questions to a set (mock-exam copies, tools). */
  app.post('/api/sets/:id/questions', async (req, res) => {
    try {
      const set = await ownedSet(req.params.id, req.user.id);
      const questions = Array.isArray(req.body?.questions) ? req.body.questions : [];
      if (questions.length === 0) throw new HttpError(400, 'questions is required.');

      const last = await one('select max(position) as max from mcqs where set_id = $1', [set.id]);
      let position = (last?.max ?? 0) + 1;

      const rows = [];
      for (const question of questions) {
        const text = String(question?.question ?? '').trim();
        const options = Array.isArray(question?.options) ? question.options.map(String) : [];
        const correct = Number(question?.correct_index);
        if (!text || options.length < 2 || !Number.isInteger(correct) || correct < 0 || correct >= options.length) {
          continue;
        }
        rows.push({
          position: position++,
          question: text,
          options,
          correct_index: correct,
          explanation: question?.explanation ?? null,
          option_explanations: Array.isArray(question?.option_explanations) ? question.option_explanations : null,
          question_type: question?.question_type ?? 'single_best_answer',
          source_page: question?.source_page ?? null,
          supporting_quote: question?.supporting_quote ?? null,
          topic: question?.topic ?? null,
          chapter_id: question?.chapter_id ?? set.chapter_id,
        });
      }
      if (rows.length === 0) throw new HttpError(400, 'No valid questions were supplied.');
      for (const chapterId of new Set(rows.map((row)=>row.chapter_id).filter(Boolean))) {
        if (!(await readableChapter(chapterId,req.user.id))) throw new HttpError(404, 'Chapter not found.');
      }

      const placeholders = [];
      const params = [];
      for (const row of rows) {
        const base = params.length;
        params.push(
          set.id,
          row.position,
          row.question,
          JSON.stringify(row.options),
          row.correct_index,
          row.explanation,
          row.option_explanations ? JSON.stringify(row.option_explanations) : null,
          row.question_type,
          row.source_page,
          row.supporting_quote,
          row.topic,
          row.chapter_id,
        );
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`,
        );
      }
      await query(
        `insert into mcqs
           (set_id, position, question, options, correct_index, explanation, option_explanations,
            question_type, source_page, supporting_quote, topic, chapter_id)
         values ${placeholders.join(', ')}`,
        params,
      );

      res.status(201).json({ count: rows.length });
    } catch (error) {
      handle(res, error, 'Could not add the questions.');
    }
  });

  /** Book counts use the full accessible pool; sampling happens on the server. */
  app.get('/api/mcqs/books', async (req, res) => {
    try {
      res.json(await many(`select b.id, b.title, b.subject, count(*)::int as count
        from mcqs m join mcq_sets s on s.id=m.set_id
        join chapters c on c.id=coalesce(m.chapter_id,s.chapter_id)
        join books b on b.id=c.book_id
        where s.user_id=$1 and (b.is_default or b.owner_id=$1)
          and not exists (select 1 from flags f where f.question_id=m.id and f.user_id=$1)
        group by b.id,b.title,b.subject order by b.title`, [req.user.id]));
    } catch (error) { handle(res,error,'Could not load the question books.'); }
  });

  app.get('/api/mcqs', async (req, res) => {
    try {
      const rawLimit=Number(req.query.limit);
      const limit=Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit),1),500) : 100;
      const sample=req.query.sample==='true';
      const rows=await many(`select m.*,s.title as set_title,b.id as book_id,b.title as book_title,b.subject as book_subject
        from mcqs m join mcq_sets s on s.id=m.set_id
        left join chapters c on c.id=coalesce(m.chapter_id,s.chapter_id)
        left join books b on b.id=c.book_id
        where s.user_id=$1 and (b.id is null or b.is_default or b.owner_id=$1)
          and not exists (select 1 from flags f where f.question_id=m.id and f.user_id=$1)
          ${req.query.book_id ? 'and b.id=$3' : ''}
        order by ${sample ? 'random()' : 'm.created_at desc, m.id'} limit $2`,
        req.query.book_id ? [req.user.id,limit,req.query.book_id] : [req.user.id,limit]);
      res.json(rows);
    } catch(error) { handle(res,error,'Could not load questions.'); }
  });

  app.post('/api/sets/:id/attempts', async (req, res) => {
    try {
      const set = await ownedSet(req.params.id, req.user.id);
      const body = req.body ?? {};
      const score = Number(body.score);
      const total = Number(body.total);
      if (!Number.isInteger(score) || !Number.isInteger(total) || total <= 0) {
        throw new HttpError(400, 'score and total are required.');
      }
      const attempt = await one(
        `insert into quiz_attempts (set_id, user_id, score, total, answers, question_ids, mode, duration_seconds)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         returning *`,
        [
          set.id,
          req.user.id,
          score,
          total,
          JSON.stringify(body.answers ?? null),
          Array.isArray(body.question_ids) ? JSON.stringify(body.question_ids) : null,
          body.mode === 'exam' ? 'exam' : 'tutor',
          Number.isInteger(body.duration_seconds) ? body.duration_seconds : null,
        ],
      );
      res.status(201).json(attempt);
    } catch (error) {
      handle(res, error, 'Could not save the attempt.');
    }
  });

  app.get('/api/attempts', async (req, res) => {
    try {
      const [countRow, rows] = await Promise.all([
        one('select count(*)::int as count from quiz_attempts where user_id = $1', [req.user.id]),
        many(
          `select a.id, a.score, a.total, a.answers, a.mode, a.duration_seconds, a.completed_at,
                  s.id as set_id, s.title as set_title,
                  c.id as chapter_id, c.title as chapter_title,
                  b.id as book_id, b.title as book_title, b.subject as book_subject
             from quiz_attempts a
             left join mcq_sets s on s.id = a.set_id
             left join chapters c on c.id = s.chapter_id
             left join books b on b.id = c.book_id
            where a.user_id = $1
            order by a.completed_at desc
            limit 200`,
          [req.user.id],
        ),
      ]);
      res.json({ count: countRow?.count ?? 0, attempts: rows });
    } catch (error) {
      handle(res, error, 'Could not load your progress.');
    }
  });

  /** Progress dashboard: totals, accuracy by book/topic and recent attempts. */
  app.get('/api/progress', async (req, res) => {
    try {
      const attempts = await many(
        `select id, set_id, score, total, answers, question_ids, mode, duration_seconds, completed_at
           from quiz_attempts
          where user_id = $1
          order by completed_at desc
          limit 200`,
        [req.user.id],
      );

      const setIds = [...new Set(attempts.map((attempt) => attempt.set_id))];
      const sets = setIds.length
        ? await many(
            `select s.id, s.title as set_title, b.title as book_title
               from mcq_sets s
               left join chapters c on c.id = s.chapter_id
               left join books b on b.id = c.book_id
              where s.id = any($1)`,
            [setIds],
          )
        : [];

      const questionIds = [
        ...new Set(
          attempts.flatMap((attempt) =>
            Array.isArray(attempt.question_ids) ? attempt.question_ids : [],
          ),
        ),
      ];
      const questions = questionIds.length
        ? await many('select id, topic, correct_index from mcqs where id = any($1)', [questionIds])
        : [];

      // Every kind of study counts towards the streak.
      const activeRows = await many(
        `select day::text as day from (
           select (completed_at at time zone 'utc')::date as day from quiz_attempts
            where user_id = $1 and completed_at is not null
           union
           select (last_reviewed_at at time zone 'utc')::date from flashcards
            where user_id = $1 and last_reviewed_at is not null
           union
           select (updated_at at time zone 'utc')::date from reading_progress
            where user_id = $1
           union
           select (created_at at time zone 'utc')::date from reader_notes
            where user_id = $1
         ) activity
         order by day desc
         limit 400`,
        [req.user.id],
      );

      res.json({
        ...summarizeProgress({ attempts, sets, questions }),
        streak: summarizeStreak({
          activeDays: activeRows.map((row) => row.day),
          today: new Date().toISOString().slice(0, 10),
        }),
      });
    } catch (error) {
      handle(res, error, 'Could not load the progress dashboard.');
    }
  });

  /** Existing spaced-repetition state for the questions of one set. */
  app.get('/api/sets/:id/reviews', async (req, res) => {
    try {
      const set = await ownedSet(req.params.id, req.user.id);
      const rows = await many(
        `select r.* from reviews r
           join mcqs m on m.id = r.question_id
          where r.user_id = $1 and m.set_id = $2`,
        [req.user.id, set.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load review state.');
    }
  });

  /** Upserts review states (the app computes the schedule; the server stores it). */
  app.post('/api/reviews', async (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rows.length === 0) throw new HttpError(400, 'rows is required.');

      await withTransaction(async (client) => {
        for (const row of rows) {
          const questionId = String(row?.question_id ?? '');
          if (!questionId) throw new HttpError(400, 'question_id is required.');
          const owned = await client.query(`select m.id from mcqs m join mcq_sets s on s.id=m.set_id
            where m.id=$1 and s.user_id=$2 for share of m,s`, [questionId,req.user.id]);
          if (!owned.rows.length) throw new HttpError(404, 'Question not found.');
          await client.query(
            `insert into reviews (user_id, question_id, due_at, stability, difficulty, reps, lapses, last_reviewed_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             on conflict (user_id, question_id) do update set
               due_at = excluded.due_at,
               stability = excluded.stability,
               difficulty = excluded.difficulty,
               reps = excluded.reps,
               lapses = excluded.lapses,
               last_reviewed_at = excluded.last_reviewed_at`,
            [
              req.user.id,
              questionId,
              row.due_at ?? new Date().toISOString(),
              Number(row.stability) || 0,
              Number(row.difficulty) || 5,
              Number(row.reps) || 0,
              Number(row.lapses) || 0,
              row.last_reviewed_at ?? null,
            ],
          );
        }
      });

      res.json({ ok: true, saved: rows.length });
    } catch (error) {
      handle(res, error, 'Could not save the review results.');
    }
  });

  /** Questions that are due for spaced review, with everything needed to run one. */
  app.get('/api/reviews/due', async (req, res) => {
    try {
      const rows = await many(
        `select r.id as review_id, r.due_at, r.stability, r.difficulty, r.reps, r.lapses,
                m.id, m.set_id, m.chapter_id, m.position, m.question, m.options, m.correct_index,
                m.explanation, m.option_explanations, m.question_type, m.source_page,
                m.supporting_quote, m.topic,
                s.title as set_title,
                b.id as book_id, b.title as book_title, b.subject as book_subject
           from reviews r
           join mcqs m on m.id = r.question_id
           left join mcq_sets s on s.id = m.set_id
           left join chapters c on c.id = m.chapter_id
           left join books b on b.id = c.book_id
          where r.user_id = $1 and s.user_id = $1 and r.due_at <= now()
          order by r.due_at
          limit 50`,
        [req.user.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load due reviews.');
    }
  });

  // ── flags + study material ───────────────────────────────────────────────────

  app.post('/api/flags', async (req, res) => {
    try {
      const questionId = String(req.body?.question_id ?? '');
      const reason = String(req.body?.reason ?? '').trim();
      if (!questionId || !reason) throw new HttpError(400, 'question_id and reason are required.');

      const question = await one(
        `select m.id from mcqs m join mcq_sets s on s.id = m.set_id
          where m.id = $1 and s.user_id = $2`,
        [questionId, req.user.id],
      );
      if (!question) throw new HttpError(404, 'Question not found.');

      const flag = await one(
        `insert into flags (question_id, user_id, reason, note)
         values ($1, $2, $3, $4)
         on conflict (question_id, user_id) do update set reason = excluded.reason, note = excluded.note
         returning *`,
        [questionId, req.user.id, reason, req.body?.note ?? null],
      );
      res.json(flag);
    } catch (error) {
      handle(res, error, 'Could not send the report.');
    }
  });

  app.get('/api/study-materials', async (req, res) => {
    try {
      const chapterId = String(req.query.chapter_id ?? '');
      if (!chapterId) throw new HttpError(400, 'chapter_id is required.');
      const rows = await many(
        'select * from study_materials where user_id = $1 and chapter_id = $2 order by created_at desc',
        [req.user.id, chapterId],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load the study material.');
    }
  });

  // ── home aggregates (quizzes tab planner) ────────────────────────────────────

  app.get('/api/planner', async (req, res) => {
    try {
      const [dueRow, chaptersRow, profile, attempts] = await Promise.all([
        one('select count(*)::int as count from reviews r join mcqs m on m.id=r.question_id join mcq_sets s on s.id=m.set_id where r.user_id=$1 and s.user_id=$1 and r.due_at<=now()', [req.user.id]),
        one(
          `select count(*)::int as count
             from chapters c join books b on b.id = c.book_id
            where b.is_default or b.owner_id = $1`,
          [req.user.id],
        ),
        one('select exam_date, target_exam from profiles where id = $1', [req.user.id]),
        many(
          `select completed_at, score, total from quiz_attempts
            where user_id = $1 order by completed_at desc limit 120`,
          [req.user.id],
        ),
      ]);
      res.json({
        dueCount: dueRow?.count ?? 0,
        totalChapters: chaptersRow?.count ?? 0,
        examDate: profile?.exam_date ?? null,
        targetExam: profile?.target_exam ?? null,
        attempts,
      });
    } catch (error) {
      handle(res, error, 'Could not load the planner.');
    }
  });

  // ── AI routes ────────────────────────────────────────────────────────────────

  app.post('/api/ai/generate-mcqs', async (req, res) => {
    try {
      const result = await generateMcqs({ userId: req.user.id, body: req.body ?? {} });
      res.json(result);
    } catch (error) {
      handle(res, error, 'Quiz generation failed.');
    }
  });

  app.post('/api/ai/replace-question', async (req, res) => {
    try {
      const result = await replaceQuestion({
        userId: req.user.id,
        questionId: String(req.body?.questionId ?? ''),
      });
      res.json(result);
    } catch (error) {
      handle(res, error, 'Could not create a replacement question.');
    }
  });

  app.post('/api/ai/study-kit', async (req, res) => {
    try {
      const result = await generateStudyKit({
        userId: req.user.id,
        chapterId: String(req.body?.chapterId ?? ''),
        kind: req.body?.kind,
        count: req.body?.count,
      });
      res.json(result);
    } catch (error) {
      handle(res, error, 'Could not create the study material.');
    }
  });

  app.post('/api/ai/ingest-book', async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.mode !== 'text') {
        throw new HttpError(400, 'Use the upload endpoint for files.');
      }
      const result = await ingestText({
        userId: req.user.id,
        title: body.title,
        subject: body.subject,
        author: body.author,
        text: body.text,
      });
      res.json(result);
    } catch (error) {
      handle(res, error, 'Could not process this book.');
    }
  });

  // ── file upload (raw bytes in, chapters out — nothing is stored) ─────────────

  app.post(
    '/api/upload/:bookId',
    async (req,res,next) => {
      try { await ownedBook(req.params.bookId,req.user.id); next(); }
      catch(error) { handle(res,error,'Upload not found.'); }
    },
    (req,res,next) => express.raw({type:()=>true,limit:'80mb'})(req,res,async (error) => {
      if (!error) { next(); return; }
      await query("update books set status='error',status_message=$2 where id=$1 and owner_id=$3 and status='processing'",
        [req.params.bookId,'The upload exceeded the file size limit.',req.user.id]).catch(()=>{});
      next(error);
    }),
    async (req, res) => {
      const bookId = req.params.bookId;
      try {
        const bytes = req.body instanceof Buffer ? new Uint8Array(req.body) : new Uint8Array();
        if (bytes.length === 0) throw new HttpError(400, 'The uploaded file was empty.');

        const fileTypeHeader = String(req.headers['x-file-type'] ?? '').trim();
        const fileType = ['pdf', 'epub', 'txt'].includes(fileTypeHeader) ? fileTypeHeader : undefined;

        const result = await ingestFile({ userId: req.user.id, bookId, bytes, fileType });
        res.json(result);
      } catch (error) {
        if (error instanceof IngestError && error.cleanup) {
          // Remove the shell book row so a failed/duplicate upload leaves nothing behind.
          await query('delete from books where id=$1 and owner_id=$2', [bookId,req.user.id]).catch(()=>{});
          const status = /already uploaded/i.test(error.message) ? 409 : 400;
          res.status(status).json({ error: error.message });
          return;
        }
        // Safety net: never leave a book stuck in "processing".
        await query(
          "update books set status = 'error', status_message = $2 where id=$1 and owner_id=$3 and status='processing'",
          [bookId, (error instanceof Error ? error.message : 'Upload failed.').slice(0,500),req.user.id],
        ).catch(() => {});
        handle(res, error, 'Could not process this book.');
      }
    },
  );

  // ── streamed uploads — any file size ─────────────────────────────────────────
  // The client sends the file in ~8 MB chunks; every chunk is appended to a
  // temp file on disk, so server memory stays flat no matter how big the book
  // is. `finish` kicks off extraction (poppler for PDFs) in the background and
  // the client polls the book row until it is ready.

  app.get('/api/reading', async (req, res) => {
    try {
      const rows = await many(
        `select p.book_id, p.chapter_id, p.offset_ratio, p.updated_at,
                b.title as book_title, b.subject as book_subject, b.author as book_author,
                c.number as chapter_number, c.title as chapter_title
           from reading_progress p
           join books b on b.id = p.book_id
           left join chapters c on c.id = p.chapter_id
          where p.user_id = $1 and (b.is_default or b.owner_id = $1)
          order by p.updated_at desc
          limit 6`,
        [req.user.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load your reading list.');
    }
  });

  app.get('/api/books/:id/reading-progress', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');
      const row = await one(
        'select chapter_id, offset_ratio, updated_at from reading_progress where user_id = $1 and book_id = $2',
        [req.user.id, req.params.id],
      );
      res.json(row ?? null);
    } catch (error) {
      handle(res, error, 'Could not load your reading position.');
    }
  });

  app.put('/api/books/:id/reading-progress', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');

      const chapterId = typeof req.body?.chapterId === 'string' ? req.body.chapterId : null;
      const ratioRaw = Number(req.body?.offsetRatio);
      const offsetRatio = Number.isFinite(ratioRaw) ? Math.min(Math.max(ratioRaw, 0), 1) : 0;

      if (chapterId) {
        const chapter = await one('select id from chapters where id = $1 and book_id = $2', [
          chapterId,
          req.params.id,
        ]);
        if (!chapter) throw new HttpError(400, 'That chapter does not belong to this book.');
      }

      await query(
        `insert into reading_progress (user_id, book_id, chapter_id, offset_ratio, updated_at)
         values ($1, $2, $3, $4, now())
         on conflict (user_id, book_id)
         do update set chapter_id = excluded.chapter_id,
                       offset_ratio = excluded.offset_ratio,
                       updated_at = now()`,
        [req.user.id, req.params.id, chapterId, offsetRatio],
      );
      res.json({ ok: true });
    } catch (error) {
      handle(res, error, 'Could not save your reading position.');
    }
  });

  // ── highlights & notes ────────────────────────────────────────────────────────

  app.get('/api/books/:id/notes', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');
      const rows = await many(
        `select n.id, n.chapter_id, n.paragraph_index, n.kind, n.text, n.note, n.color, n.created_at,
                c.number as chapter_number, c.title as chapter_title
           from reader_notes n
           join chapters c on c.id = n.chapter_id
          where n.user_id = $1 and n.book_id = $2
          order by c.number, n.paragraph_index`,
        [req.user.id, req.params.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load your notes.');
    }
  });

  app.post('/api/books/:id/notes', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');

      const chapterId = typeof req.body?.chapterId === 'string' ? req.body.chapterId : '';
      const paragraphIndex = Number(req.body?.paragraphIndex);
      const kind = req.body?.kind === 'note' ? 'note' : 'highlight';
      const text = String(req.body?.text ?? '').slice(0, 2000).trim();
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000).trim() : null;
      const color = ['gold', 'blue', 'green', 'pink'].includes(req.body?.color)
        ? req.body.color
        : 'gold';

      if (!chapterId || !Number.isInteger(paragraphIndex) || paragraphIndex < 0) {
        throw new HttpError(400, 'Missing highlight position.');
      }
      if (!text && !note) throw new HttpError(400, 'Nothing to save.');

      const chapter = await one('select id from chapters where id = $1 and book_id = $2', [
        chapterId,
        req.params.id,
      ]);
      if (!chapter) throw new HttpError(400, 'That chapter does not belong to this book.');

      const row = await one(
        `insert into reader_notes (user_id, book_id, chapter_id, paragraph_index, kind, text, note, color)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, chapter_id, paragraph_index, kind, text, note, color, created_at`,
        [req.user.id, req.params.id, chapterId, paragraphIndex, kind, text, note, color],
      );
      res.status(201).json(row);
    } catch (error) {
      handle(res, error, 'Could not save that.');
    }
  });

  app.delete('/api/notes/:id', async (req, res) => {
    try {
      const row = await one('select id from reader_notes where id = $1 and user_id = $2', [
        req.params.id,
        req.user.id,
      ]);
      if (!row) throw new HttpError(404, 'Not found.');
      await query('delete from reader_notes where id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (error) {
      handle(res, error, 'Could not delete that.');
    }
  });

  // ── all notes (across books) ─────────────────────────────────────────────────

  app.get('/api/notes', async (req, res) => {
    try {
      const rows = await many(
        `select n.id, n.book_id, n.chapter_id, n.paragraph_index, n.kind, n.text, n.note, n.color, n.created_at,
                c.number as chapter_number, c.title as chapter_title,
                b.title as book_title
           from reader_notes n
           join chapters c on c.id = n.chapter_id
           join books b on b.id = n.book_id
          where n.user_id = $1
          order by n.created_at desc
          limit 500`,
        [req.user.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load your notes.');
    }
  });

  // ── flashcard decks (spaced repetition) ──────────────────────────────────────

  /** Saves a chapter's generated cards into the book's review deck (dedupes on front). */
  app.post('/api/flashcards', async (req, res) => {
    try {
      const chapterId = String(req.body?.chapterId ?? '');
      const cards = Array.isArray(req.body?.cards) ? req.body.cards.slice(0, 100) : [];
      if (!chapterId || cards.length === 0) {
        throw new HttpError(400, 'chapterId and cards are required.');
      }

      const chapter = await readableChapter(chapterId, req.user.id);
      if (!chapter) throw new HttpError(404, 'Chapter not found.');

      let saved = 0;
      await withTransaction(async (client) => {
        for (const card of cards) {
          const front = String(card?.front ?? '').trim().slice(0, 600);
          const back = String(card?.back ?? '').trim().slice(0, 600);
          if (!front || !back) continue;
          const topic = typeof card?.topic === 'string' ? card.topic.slice(0, 120) : null;
          const exists = await client.query(
            'select id from flashcards where user_id = $1 and book_id = $2 and front = $3 limit 1',
            [req.user.id, chapter.book_id, front],
          );
          if (exists.rowCount > 0) continue;
          await client.query(
            `insert into flashcards (user_id, book_id, chapter_id, front, back, topic)
             values ($1, $2, $3, $4, $5, $6)`,
            [req.user.id, chapter.book_id, chapterId, front, back, topic],
          );
          saved += 1;
        }
      });
      res.status(201).json({ ok: true, saved });
    } catch (error) {
      handle(res, error, 'Could not save the cards.');
    }
  });

  /** One deck per book that has cards, with due counts for the deck list. */
  app.get('/api/decks', async (req, res) => {
    try {
      const rows = await many(
        `select f.book_id, b.title as book_title,
                count(*)::int as total,
                count(*) filter (where f.due_at <= now())::int as due,
                min(f.due_at) as next_due
           from flashcards f
           join books b on b.id = f.book_id
          where f.user_id = $1
          group by f.book_id, b.title
          order by due desc, b.title`,
        [req.user.id],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load your decks.');
    }
  });

  /** All cards of one deck, due first. */
  app.get('/api/decks/:bookId/cards', async (req, res) => {
    try {
      const book = await readableBook(req.params.bookId, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');
      const rows = await many(
        `select id, book_id, chapter_id, front, back, topic,
                stability, difficulty, reps, lapses, due_at, last_reviewed_at
           from flashcards
          where user_id = $1 and book_id = $2
          order by due_at asc
          limit 500`,
        [req.user.id, req.params.bookId],
      );
      res.json(rows);
    } catch (error) {
      handle(res, error, 'Could not load the deck.');
    }
  });

  /** Stores the schedule the app computed after grading one card. */
  app.patch('/api/flashcards/:id', async (req, res) => {
    try {
      const card = await one('select id from flashcards where id = $1 and user_id = $2', [
        req.params.id,
        req.user.id,
      ]);
      if (!card) throw new HttpError(404, 'Card not found.');
      const updated = await one(
        `update flashcards
            set stability = $2, difficulty = $3, reps = $4, lapses = $5,
                due_at = $6, last_reviewed_at = $7
          where id = $1
          returning id, stability, difficulty, reps, lapses, due_at, last_reviewed_at`,
        [
          req.params.id,
          Number(req.body?.stability) || 0,
          Number(req.body?.difficulty) || 5,
          Number(req.body?.reps) || 0,
          Number(req.body?.lapses) || 0,
          req.body?.due_at ?? new Date().toISOString(),
          req.body?.last_reviewed_at ?? new Date().toISOString(),
        ],
      );
      res.json(updated);
    } catch (error) {
      handle(res, error, 'Could not update the card.');
    }
  });

  app.delete('/api/flashcards/:id', async (req, res) => {
    try {
      const row = await one('select id from flashcards where id = $1 and user_id = $2', [
        req.params.id,
        req.user.id,
      ]);
      if (!row) throw new HttpError(404, 'Not found.');
      await query('delete from flashcards where id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (error) {
      handle(res, error, 'Could not delete the card.');
    }
  });

  // ── in-book search ────────────────────────────────────────────────────────────

  app.get('/api/books/:id/search', async (req, res) => {
    try {
      const book = await readableBook(req.params.id, req.user.id);
      if (!book) throw new HttpError(404, 'Book not found.');

      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
      if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters to search.');

      // ILIKE runs against the chapters_content_trgm_idx trigram index (schema.sql);
      // escape LIKE wildcards in the user's query. position() gives the offset.
      const pattern = `%${q.replace(/([\\%_])/g, '\\$1')}%`;
      const rows = await many(
        `select c.id as chapter_id, c.number, c.title,
                position(lower($3) in lower(c.content)) as position,
                ((length(c.content) - length(replace(lower(c.content), lower($3), ''))) / length($3))::int as hits,
                substring(c.content from greatest(position(lower($3) in lower(c.content)) - 80, 1) for 220) as snippet
           from chapters c
          where c.book_id = $1 and c.content ilike $2
          order by c.number
          limit 30`,
        [req.params.id, pattern, q],
      );
      res.json({ query: q, results: rows });
    } catch (error) {
      handle(res, error, 'Could not search this book.');
    }
  });

  // ── ask this book ─────────────────────────────────────────────────────────────

  app.post('/api/books/:id/ask', async (req, res) => {
    try {
      const result = await answerQuestion({
        userId: req.user.id,
        bookId: req.params.id,
        question: req.body?.question,
      });
      res.json(result);
    } catch (error) {
      handle(res, error, 'Could not answer that right now.');
    }
  });

  // ── fallbacks ────────────────────────────────────────────────────────────────

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // Body-parser errors (e.g. files above the 80 MB limit) become friendly JSON.
  app.use(async (error, req, res, _next) => {
    // Client disconnects (deploy swaps, dropped networks) are not server
    // errors — the socket is gone, so there is nothing to respond to.
    if (
      error?.message === 'request aborted' ||
      error?.code === 'ECONNRESET' ||
      error?.type === 'request.aborted'
    ) {
      if (!res.headersSent) {
        try {
          res.end();
        } catch {
          // The connection was already torn down.
        }
      }
      return;
    }
    if (error?.type === 'entity.too.large') {
      res.status(413).json({
        error:
          'This file is too large to process (max 80 MB). Split the book into smaller parts and upload those, or import the text instead.',
      });
      return;
    }
    if (error?.type==='entity.parse.failed') {
      res.status(400).json({error:'The request body is not valid JSON.'});
      return;
    }
    console.error('Unhandled error:', error?.message ?? error);
    res.status(500).json({ error: 'Unexpected server error.' });
  });


  return app;
}
