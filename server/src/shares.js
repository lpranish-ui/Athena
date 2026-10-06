// ============================================================================
// Share links — public read-only snapshots of a quiz, a review deck, or a
// saved highlight/note. The payload is captured at share time so a link keeps
// working even if the original is edited or deleted. Recipients need no
// account: GET /api/shares/:token bypasses the auth middleware.
// ============================================================================

import crypto from 'node:crypto';

import * as defaultDatabase from './db.js';
import { HttpError } from './http.js';

const KINDS = new Set(['set', 'deck', 'note']);
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function makeToken() {
  let token = '';
  for (let index = 0; index < 14; index++) {
    token += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
  }
  return token;
}

/** Snapshots a quiz set (questions, choices, explanations — answers included). */
async function buildSetPayload(database, userId, setId) {
  const set = await database.one(
    `select s.title, s.difficulty, b.title as book_title
       from mcq_sets s
       left join chapters c on c.id = s.chapter_id
       left join books b on b.id = c.book_id
      where s.id = $1 and s.user_id = $2`,
    [setId, userId],
  );
  if (!set) throw new HttpError(404, 'Quiz not found (or it is not yours).');
  const questions = await database.many(
    `select question, options, correct_index, explanation, question_type, supporting_quote, topic
       from mcqs where set_id = $1 order by position asc`,
    [setId],
  );
  if (!questions.length) throw new HttpError(400, 'This quiz has no questions yet.');
  return {
    title: set.title,
    book_title: set.book_title,
    difficulty: set.difficulty,
    questions,
  };
}

/** Snapshots every card of a book's review deck. */
async function buildDeckPayload(database, userId, bookId) {
  const cards = await database.many(
    `select front, back, topic from flashcards
      where user_id = $1 and book_id = $2 order by created_at asc`,
    [userId, bookId],
  );
  if (!cards.length) throw new HttpError(400, 'This deck has no cards yet.');
  const book = await database.one('select title from books where id = $1', [bookId]);
  return { book_title: book?.title ?? null, cards };
}

/** Snapshots a saved highlight or note with its book/chapter context. */
async function buildNotePayload(database, userId, noteId) {
  const note = await database.one(
    `select n.kind, n.text, n.color, n.paragraph_index, n.created_at,
            c.title as chapter_title, b.title as book_title
       from reader_notes n
       join chapters c on c.id = n.chapter_id
       join books b on b.id = n.book_id
      where n.id = $1 and n.user_id = $2`,
    [noteId, userId],
  );
  if (!note) throw new HttpError(404, 'Note not found (or it is not yours).');
  return {
    kind: note.kind,
    text: note.text,
    color: note.color,
    paragraph_index: note.paragraph_index,
    chapter_title: note.chapter_title,
    book_title: note.book_title,
    created_at: note.created_at,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public route — must be registered BEFORE the auth middleware in app.js. */
export function registerPublicShareRoutes(app, { database = defaultDatabase } = {}) {
  app.get('/api/shares/:token', async (req, res) => {
    try {
      const token = String(req.params.token ?? '');
      if (!/^[A-Za-z0-9]{8,24}$/.test(token)) throw new HttpError(404, 'This link is not valid.');
      const link = await database.one(
        'select id, kind, payload, created_at from share_links where token = $1',
        [token],
      );
      if (!link) throw new HttpError(404, 'This link is not valid.');
      void database
        .query('update share_links set views = views + 1 where id = $1', [link.id])
        .catch(() => {});
      res.json({ kind: link.kind, payload: link.payload, created_at: link.created_at });
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('share read failed', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Could not open this shared link.' });
    }
  });
}

/** Signed-in route — creates the snapshot + link. */
export function registerShareRoutes(app, { database = defaultDatabase } = {}) {
  app.post('/api/shares', async (req, res) => {
    try {
      const kind = String(req.body?.kind ?? '');
      const id = String(req.body?.id ?? '');
      if (!KINDS.has(kind) || !UUID_PATTERN.test(id)) {
        throw new HttpError(400, 'Choose what to share.');
      }
      const payload =
        kind === 'set'
          ? await buildSetPayload(database, req.user.id, id)
          : kind === 'deck'
            ? await buildDeckPayload(database, req.user.id, id)
            : await buildNotePayload(database, req.user.id, id);

      let token = makeToken();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const taken = await database.one('select 1 as x from share_links where token = $1', [token]);
        if (!taken) break;
        token = makeToken();
      }
      await database.query(
        'insert into share_links (token, user_id, kind, payload) values ($1, $2, $3, $4::jsonb)',
        [token, req.user.id, kind, JSON.stringify(payload)],
      );
      res.json({ token, kind });
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('share create failed', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Could not create a share link.' });
    }
  });
}
