// ============================================================================
// Athena API — the whole backend: auth, library, quizzes, spaced repetition,
// study tools and AI routes. Deployed on Render against the LA carte
// Postgres instance. See server/sql/schema.sql for the database.
// ============================================================================

import { readFile } from 'node:fs/promises';

import cors from 'cors';
import express from 'express';

import { registerAuthRoutes, requireAuth } from './auth.js';
import { many, one, query, withTransaction } from './db.js';
import { generateMcqs, replaceQuestion } from './generate.js';
import { registerGroupRoutes } from './group.js';
import { HttpError } from './http.js';
import { IngestError, ingestFile, ingestText } from './ingest.js';
import { generateStudyKit } from './studykit.js';

const app = express();

app.set('trust proxy', true);
app.use(cors());
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
registerAuthRoutes(app);

// Everything else under /api requires a signed-in user.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health') {
    next();
    return;
  }
  requireAuth(req, res, next);
});

// Multiplayer group-study routes (a signed-in user is required).
registerGroupRoutes(app);

/** Sends a thrown error with the right status and a `{ error }` body. */
function handle(res, error, fallback) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(fallback, error instanceof Error ? error.message : error);
  res.status(500).json({ error: error instanceof Error && error.message ? error.message : fallback });
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
  try {
    const chapter = await ownedChapter(req.params.id, req.user.id);
    await withTransaction(async (client) => {
      await client.query('delete from chapters where id = $1', [chapter.id]);
      const remaining = await client.query(
        'select id from chapters where book_id = $1 order by number, id',
        [chapter.book_id],
      );
      await renumberChapters(
        client,
        remaining.rows.map((row) => row.id),
      );
    });
    res.json({ ok: true });
  } catch (error) {
    handle(res, error, 'Could not delete the chapter.');
  }
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
  try {
    const source = await ownedChapter(req.params.id, req.user.id);
    const intoId = String(req.body?.intoId ?? '');
    if (!intoId || intoId === source.id) throw new HttpError(400, 'intoId must be another chapter.');
    const target = await ownedChapter(intoId, req.user.id);
    if (target.book_id !== source.book_id) {
      throw new HttpError(400, 'Chapters from different books cannot be merged.');
    }

    const separator = '\n\n';
    const header = `${source.title}\n`;
    const offset = target.content.length + separator.length + header.length;

    const mergedContent = `${target.content}${separator}${header}${source.content}`;

    let mergedMap = null;
    const targetMap = Array.isArray(target.page_map) ? target.page_map : [];
    const sourceMap = Array.isArray(source.page_map) ? source.page_map : [];
    if (targetMap.length > 0 || sourceMap.length > 0) {
      mergedMap = [
        ...targetMap,
        ...sourceMap
          .filter((mark) => mark && Number.isInteger(mark.page) && Number.isInteger(mark.char_start))
          .map((mark) => ({ page: mark.page, char_start: mark.char_start + offset })),
      ];
    }

    const firstPage =
      target.first_page ?? source.first_page ?? null;
    const lastCandidates = [target.last_page, source.last_page].filter((value) => Number.isInteger(value));
    const lastPage = lastCandidates.length > 0 ? Math.max(...lastCandidates) : null;

    await withTransaction(async (client) => {
      await client.query(
        `update chapters
            set content = $2, page_map = $3::jsonb, first_page = $4, last_page = $5
          where id = $1`,
        [target.id, mergedContent, mergedMap ? JSON.stringify(mergedMap) : null, firstPage, lastPage],
      );

      // Re-point every quiz that referenced the removed chapter.
      await client.query(
        'update mcq_sets set chapter_id = $2 where chapter_id = $1',
        [source.id, target.id],
      );
      await client.query(
        'update mcq_sets set chapter_ids = array_replace(chapter_ids, $2, $1) where $1 = any(chapter_ids)',
        [source.id, target.id],
      );

      await client.query('delete from chapters where id = $1', [source.id]);
      const remaining = await client.query(
        'select id from chapters where book_id = $1 order by number, id',
        [source.book_id],
      );
      await renumberChapters(
        client,
        remaining.rows.map((row) => row.id),
      );
    });

    res.json({ ok: true, keptChapterId: target.id });
  } catch (error) {
    handle(res, error, 'Could not merge the chapters.');
  }
});

// ── quiz sets ────────────────────────────────────────────────────────────────

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

/** A flexible sample of the user's questions (used by the mock-exam builder). */
app.get('/api/mcqs', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = await many(
      `select m.*, s.title as set_title, b.id as book_id, b.title as book_title, b.subject as book_subject
         from mcqs m
         join mcq_sets s on s.id = m.set_id
         left join books b on b.id = s.chapter_id
        where s.user_id = $1 ${req.query.book_id ? 'and b.id = $3' : ''}
        order by m.created_at desc
        limit $2`,
      req.query.book_id ? [req.user.id, limit, req.query.book_id] : [req.user.id, limit],
    );
    res.json(rows);
  } catch (error) {
    handle(res, error, 'Could not load questions.');
  }
});

// ── attempts + reviews ───────────────────────────────────────────────────────

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
      `insert into quiz_attempts (set_id, user_id, score, total, answers, mode, duration_seconds)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       returning *`,
      [
        set.id,
        req.user.id,
        score,
        total,
        JSON.stringify(body.answers ?? null),
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
        if (!questionId) continue;
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
        where r.user_id = $1 and r.due_at <= now()
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
      one('select count(*)::int as count from reviews where user_id = $1 and due_at <= now()', [req.user.id]),
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
  express.raw({ type: () => true, limit: '80mb' }),
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
        await query('delete from books where id = $1', [bookId]).catch(() => {});
        const status = /already uploaded/i.test(error.message) ? 409 : 400;
        res.status(status).json({ error: error.message });
        return;
      }
      handle(res, error, 'Could not process this book.');
    }
  },
);

// ── fallbacks ────────────────────────────────────────────────────────────────

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Body-parser errors (e.g. files above the 80 MB limit) become friendly JSON.
app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    res.status(413).json({
      error: 'This file is too large to process (max 80 MB). Try a smaller file, or import the text instead.',
    });
    return;
  }
  console.error('Unhandled error:', error?.message ?? error);
  res.status(500).json({ error: 'Unexpected server error.' });
});

// Keep the database schema up to date on every boot (every statement is
// idempotent, so new tables roll out automatically with each deploy).
try {
  const schemaSql = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  await query(schemaSql);
  console.log('Database schema is up to date.');
} catch (error) {
  console.error('Schema bootstrap failed:', error instanceof Error ? error.message : error);
}

const port = Number(process.env.PORT) || 8787;
app.listen(port, '0.0.0.0', () => {
  console.log(`Athena API listening on http://0.0.0.0:${port}`);
});
