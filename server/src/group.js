// ============================================================================
// Group study — live multiplayer quiz rooms.
// ============================================================================
// Flow: a host creates a room for one of their quiz sets and shares the
// 6-letter code. Everyone in the room gets the same question at the same
// time; the first correct answers earn more points (correctness first,
// speed as the bonus + tie-breaker). After every round a mini leaderboard
// shows, and a global leaderboard aggregates finished games.
//
// Sync is server-authoritative with lazy phase transitions: every read or
// action advances the room clock (question ends when the timer runs out or
// everyone has answered; the reveal screen shows for a few seconds, then the
// next question starts automatically). Clients simply poll the room state.
// ============================================================================

import crypto from 'node:crypto';

import { many, one, query, withTransaction } from './db.js';
import { HttpError } from './http.js';

export const QUESTION_MS = 25_000; // time to answer each question
export const REVEAL_MS = 9_000; // how long the answer is shown before the next one
const BASE_POINTS = 100;
const MAX_SPEED_BONUS = 50; // answers within the first second
const MIN_QUESTIONS = 3;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L ambiguity

function makeCode() {
  let code = '';
  for (let index = 0; index < 6; index++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** Points: 100 for a correct answer + up to 50 speed bonus (1 point per saved second). */
export function pointsFor(elapsedMs) {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  return BASE_POINTS + Math.max(0, MAX_SPEED_BONUS - seconds);
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('group route failed:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Unexpected server error.' });
    }
  };
}

async function roomByCode(code) {
  return one('select * from group_rooms where code = $1', [String(code ?? '').toUpperCase().trim()]);
}

async function roomById(id) {
  return one('select * from group_rooms where id = $1', [id]);
}

/** The quiz question at `index` (0-based) of the room's set. */
async function questionAt(setId, index) {
  return one(
    `select id, position, question, options, correct_index, explanation, option_explanations,
            question_type, source_page, supporting_quote, topic
       from mcqs
      where set_id = $1
      order by position, created_at
      offset $2 limit 1`,
    [setId, index],
  );
}

async function playerFor(roomId, userId) {
  return one('select * from group_players where room_id = $1 and user_id = $2', [roomId, userId]);
}

async function everyoneAnswered(room) {
  if (room.phase !== 'question') return false;
  const counts = await one(
    `select
       (select count(*)::int from group_players where room_id = $1) as players,
       (select count(*)::int from group_answers where room_id = $1 and question_index = $2) as answers`,
    [room.id, room.current_index],
  );
  return (counts?.players ?? 0) > 0 && (counts?.answers ?? 0) >= (counts?.players ?? 0);
}

async function startQuestion(roomId, index) {
  const now = Date.now();
  return one(
    `update group_rooms
        set phase = 'question', current_index = $2,
            question_started_at = $3, question_ends_at = $4, reveal_ends_at = null
      where id = $1 returning *`,
    [roomId, index, new Date(now).toISOString(), new Date(now + QUESTION_MS).toISOString()],
  );
}

/**
 * Lazily advances the room to the correct phase for "now":
 * question -> reveal (all answered or timer over) -> next question / finished.
 */
async function advanceRoom(room) {
  let current = room;

  if (current.status !== 'playing') return current;

  if (current.phase === 'question') {
    const over =
      (current.question_ends_at && new Date(current.question_ends_at).getTime() <= Date.now()) ||
      (await everyoneAnswered(current));
    if (over) {
      current = await one(
        `update group_rooms set phase = 'reveal', reveal_ends_at = $2 where id = $1 returning *`,
        [current.id, new Date(Date.now() + REVEAL_MS).toISOString()],
      );
    }
  }

  if (current.phase === 'reveal' && current.reveal_ends_at) {
    if (new Date(current.reveal_ends_at).getTime() <= Date.now()) {
      const nextIndex = current.current_index + 1;
      if (nextIndex >= current.question_count) {
        current = await one(
          `update group_rooms set phase = 'done', status = 'finished' where id = $1 returning *`,
          [current.id],
        );
      } else {
        current = await startQuestion(current.id, nextIndex);
      }
    }
  }

  return current;
}

/** Full room state for one player (question payload hides the answer until reveal). */
async function buildState(room, userId) {
  const advanced = await advanceRoom(room);
  const current = await roomById(advanced.id);

  const players = await many(
    `select p.id, p.user_id, p.name, p.score, p.correct_count, p.total_ms, p.joined_at,
            a.option_index as answer_option, a.correct as answer_correct, a.elapsed_ms as answer_ms
       from group_players p
       left join group_answers a
         on a.player_id = p.id and a.room_id = p.room_id and a.question_index = $2
      where p.room_id = $1
      order by p.score desc, p.total_ms asc, p.joined_at asc`,
    [current.id, current.current_index],
  );

  const playerList = players.map((player) => ({
    id: player.id,
    name: player.name,
    isHost: player.user_id === current.host_id,
    score: player.score,
    correctCount: player.correct_count,
    totalMs: Number(player.total_ms),
    answeredCurrent: player.answer_option !== null,
  }));

  const me = players.find((player) => player.user_id === userId) ?? null;

  let question = null;
  let reveal = null;

  if (current.status !== 'lobby') {
    const row = await questionAt(current.set_id, current.current_index);
    if (row) {
      const base = {
        id: row.id,
        question: row.question,
        options: row.options,
        topic: row.topic,
        questionType: row.question_type,
      };

      if (current.phase === 'question') {
        question = base; // no correct_index — that would be cheating
      } else {
        const answers = await many(
          `select player_id, option_index, correct, elapsed_ms
             from group_answers
            where room_id = $1 and question_index = $2`,
          [current.id, current.current_index],
        );
        const fastest = answers
          .filter((answer) => answer.correct)
          .sort((a, b) => a.elapsed_ms - b.elapsed_ms)[0];
        reveal = {
          ...base,
          correctIndex: row.correct_index,
          explanation: row.explanation,
          optionExplanations: row.option_explanations,
          sourcePage: row.source_page,
          supportingQuote: row.supporting_quote,
          fastestPlayerId: fastest?.player_id ?? null,
          answers: answers.map((answer) => ({
            playerId: answer.player_id,
            optionIndex: answer.option_index,
            correct: answer.correct,
            elapsedMs: answer.elapsed_ms,
            points: answer.correct ? pointsFor(answer.elapsed_ms) : 0,
          })),
        };
      }
    }
  }

  return {
    room: {
      code: current.code,
      title: current.title,
      status: current.status,
      phase: current.phase,
      currentIndex: current.current_index,
      questionCount: current.question_count,
      questionEndsAt: current.question_ends_at,
      revealEndsAt: current.reveal_ends_at,
      serverNow: new Date().toISOString(),
      isHost: current.host_id === userId,
    },
    players: playerList,
    me: me
      ? {
          id: me.id,
          score: me.score,
          correctCount: me.correct_count,
          answeredCurrent: me.answer_option !== null,
          currentAnswer:
            me.answer_option !== null
              ? {
                  optionIndex: me.answer_option,
                  correct: me.answer_correct,
                  elapsedMs: me.answer_ms,
                  points: me.answer_correct ? pointsFor(me.answer_ms) : 0,
                }
              : null,
        }
      : null,
    question,
    reveal,
  };
}

/** The player's display name: their profile name, or their email handle. */
async function displayNameFor(userId, override) {
  const custom = String(override ?? '').trim();
  if (custom) return custom.slice(0, 30);

  const profile = await one('select full_name from profiles where id = $1', [userId]);
  const user = await one('select email from users where id = $1', [userId]);
  const name = profile?.full_name?.trim();
  if (name) return name.slice(0, 30);
  return String(user?.email ?? 'Player').split('@')[0].slice(0, 30);
}

// ── routes ───────────────────────────────────────────────────────────────────

export function registerGroupRoutes(app) {
  /** Creates a room for one of the caller's quiz sets. */
  app.post(
    '/api/group/rooms',
    wrap(async (req, res) => {
      const setId = String(req.body?.setId ?? '');
      const set = await one('select * from mcq_sets where id = $1', [setId]);
      if (!set || set.user_id !== req.user.id) {
        throw new HttpError(404, 'Quiz not found (or it is not yours).');
      }

      const counted = await one('select count(*)::int as count from mcqs where set_id = $1', [setId]);
      if ((counted?.count ?? 0) < MIN_QUESTIONS) {
        throw new HttpError(
          400,
          `A group game needs at least ${MIN_QUESTIONS} questions — generate a bigger set first.`,
        );
      }

      const name = await displayNameFor(req.user.id, req.body?.name);

      let room = null;
      for (let attempt = 0; attempt < 6 && !room; attempt++) {
        try {
          room = await one(
            `insert into group_rooms (code, host_id, set_id, title, question_count)
             values ($1, $2, $3, $4, $5) returning *`,
            [makeCode(), req.user.id, setId, set.title ?? 'Group quiz', counted.count],
          );
        } catch (error) {
          if (error?.code !== '23505') throw error; // retry only code collisions
        }
      }
      if (!room) throw new HttpError(500, 'Could not create the room. Please try again.');

      await query(
        `insert into group_players (room_id, user_id, name) values ($1, $2, $3)
         on conflict (room_id, user_id) do update set name = excluded.name`,
        [room.id, req.user.id, name],
      );

      res.status(201).json({ code: room.code, roomId: room.id });
    }),
  );

  /** Joins a room by code (also lets a player update their display name). */
  app.post(
    '/api/group/rooms/:code/join',
    wrap(async (req, res) => {
      const room = await roomByCode(req.params.code);
      if (!room) throw new HttpError(404, 'No game found with that code.');
      if (room.status === 'finished') throw new HttpError(409, 'That game has already finished.');

      const name = await displayNameFor(req.user.id, req.body?.name);
      await query(
        `insert into group_players (room_id, user_id, name) values ($1, $2, $3)
         on conflict (room_id, user_id) do update set name = excluded.name`,
        [room.id, req.user.id, name],
      );

      res.json({ code: room.code, roomId: room.id, title: room.title, status: room.status });
    }),
  );

  /** The room state every client polls (fast: ~1s during questions). */
  app.get(
    '/api/group/rooms/:code',
    wrap(async (req, res) => {
      const room = await roomByCode(req.params.code);
      if (!room) throw new HttpError(404, 'No game found with that code.');
      const player = await playerFor(room.id, req.user.id);
      if (!player) throw new HttpError(403, 'Join the game first.');
      res.json(await buildState(room, req.user.id));
    }),
  );

  /** Host starts the game from the lobby. */
  app.post(
    '/api/group/rooms/:code/start',
    wrap(async (req, res) => {
      const room = await roomByCode(req.params.code);
      if (!room) throw new HttpError(404, 'No game found with that code.');
      if (room.host_id !== req.user.id) throw new HttpError(403, 'Only the host can start the game.');
      if (room.status !== 'lobby') throw new HttpError(409, 'The game has already started.');

      const counted = await one('select count(*)::int as count from group_players where room_id = $1', [
        room.id,
      ]);
      if ((counted?.count ?? 0) < 1) throw new HttpError(400, 'Nobody is in the room yet.');

      const updated = await startQuestion(room.id, 0);
      res.json(await buildState(updated, req.user.id));
    }),
  );

  /** Host advances early from the reveal screen (or the timer does it). */
  app.post(
    '/api/group/rooms/:code/next',
    wrap(async (req, res) => {
      let room = await roomByCode(req.params.code);
      if (!room) throw new HttpError(404, 'No game found with that code.');
      if (room.host_id !== req.user.id) {
        throw new HttpError(403, 'Only the host can move to the next question.');
      }
      room = await advanceRoom(room);
      if (room.phase === 'reveal') {
        room = await one(
          'update group_rooms set reveal_ends_at = now() where id = $1 returning *',
          [room.id],
        );
        room = await advanceRoom(room);
      }
      res.json(await buildState(room, req.user.id));
    }),
  );

  /** Submit an answer for the current question (first answer counts). */
  app.post(
    '/api/group/rooms/:code/answer',
    wrap(async (req, res) => {
      const room = await roomByCode(req.params.code);
      if (!room) throw new HttpError(404, 'No game found with that code.');
      const player = await playerFor(room.id, req.user.id);
      if (!player) throw new HttpError(403, 'Join the game first.');

      const advanced = await advanceRoom(room);
      if (advanced.status !== 'playing' || advanced.phase !== 'question') {
        throw new HttpError(409, 'There is no question open right now.');
      }

      const questionIndex = Number(req.body?.questionIndex);
      const optionIndex = Number(req.body?.optionIndex);
      if (!Number.isInteger(questionIndex) || questionIndex !== advanced.current_index) {
        throw new HttpError(409, 'That question is already over.');
      }
      if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 7) {
        throw new HttpError(400, 'optionIndex is required.');
      }

      const existing = await one(
        'select id from group_answers where room_id = $1 and player_id = $2 and question_index = $3',
        [advanced.id, player.id, questionIndex],
      );
      if (existing) throw new HttpError(409, 'You have already answered this question.');

      const row = await questionAt(advanced.set_id, questionIndex);
      if (!row) throw new HttpError(404, 'Question not found.');

      const elapsedMs = Math.max(
        0,
        Math.min(QUESTION_MS, Date.now() - new Date(advanced.question_started_at).getTime()),
      );
      const correct = optionIndex === row.correct_index;
      const points = correct ? pointsFor(elapsedMs) : 0;

      await withTransaction(async (client) => {
        await client.query(
          `insert into group_answers (room_id, player_id, question_id, question_index, option_index, correct, elapsed_ms)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [advanced.id, player.id, row.id, questionIndex, optionIndex, correct, elapsedMs],
        );
        await client.query(
          `update group_players
              set score = score + $2, correct_count = correct_count + $3, total_ms = total_ms + $4
            where id = $1`,
          [player.id, points, correct ? 1 : 0, correct ? elapsedMs : 0],
        );
      });

      // Answering may complete the round for everyone — advance right away.
      const after = await roomById(advanced.id);
      const state = await buildState(after, req.user.id);

      res.json({ correct, points, elapsedMs, state });
    }),
  );

  /** Global leaderboard across all finished games. */
  app.get(
    '/api/group/leaderboard',
    wrap(async (_req, res) => {
      const rows = await many(
        `with finished as (
           select p.user_id, p.name, p.room_id, p.score,
                  rank() over (partition by p.room_id order by p.score desc, p.total_ms asc) as rnk
             from group_players p
             join group_rooms r on r.id = p.room_id and r.status = 'finished'
         )
         select user_id, max(name) as name,
                sum(score)::int as points,
                count(*)::int as games,
                count(*) filter (where rnk = 1)::int as wins
           from finished
          group by user_id
          order by points desc, wins desc
          limit 50`,
      );
      res.json(rows);
    }),
  );
}
