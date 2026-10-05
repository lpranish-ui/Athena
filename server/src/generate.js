// ============================================================================
// Quiz generation — turns one or MORE chapters into multiple-choice questions
// with DeepSeek, plus one-tap replacement for flagged questions.
// ============================================================================
// Node port of the Supabase edge functions `generate-mcqs` and
// `replace-question`. All prompt building, quote verification and validation
// lives in ./questions.js.
//
// Quality pipeline (identical to the edge version):
//   AI draft -> JSON parse -> per-question validation (word-for-word quote
//   must exist in the chapter; page/chapter located from the text, never
//   trusted from the model) -> Jaccard near-duplicate filter -> blind second-
//   model answer check (questions the verifier disagrees with are dropped).
// ============================================================================

import { chatJson, getVerifyModel, MissingKeyError } from './ai.js';
import { one, query } from './db.js';
import { HttpError } from './http.js';
import {
  QUESTION_TYPES,
  SYSTEM_PROMPT,
  fixedChaptersSection,
  normalizeForMatch,
  parseQuestions,
  requestSection,
  validateQuestion,
  withPageMarkers,
} from './questions.js';

const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 20;
const MAX_CHAPTERS_PER_SET = 8;
const TOTAL_PROMPT_CHAR_BUDGET = 32000;
const PER_CHAPTER_CHAR_CAP = 16000;
const NEAR_DUPLICATE_THRESHOLD = 0.75;

// ── near-duplicate detection (Jaccard similarity over word sets) ────────────

function tokenSet(text) {
  return new Set(
    normalizeForMatch(text)
      .split(' ')
      .filter((word) => word.length > 2),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

// ── shared loading ───────────────────────────────────────────────────────────

/**
 * Loads chapters the user can study (their own books or the built-in library),
 * in the order requested. Throws 404 when any chapter is missing.
 */
async function loadChapterContexts(userId, ids) {
  const rows = await query(
    `select c.id, c.title, c.number, c.content, c.page_map, c.first_page, c.last_page,
            b.title as book_title, b.subject as book_subject
       from chapters c
       join books b on b.id = c.book_id
      where c.id = any($1::uuid[]) and (b.is_default or b.owner_id = $2)`,
    [ids, userId],
  );

  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const ordered = ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
  if (ordered.length !== ids.length) {
    throw new HttpError(404, 'Some chapters were not found (or you cannot access them).');
  }
  return ordered;
}

async function getTargetExam(userId) {
  const profile = await one('select target_exam from profiles where id = $1', [userId]);
  return profile?.target_exam ?? null;
}

/**
 * Blind check: a second, cheaper model answers each question from the same
 * passages without ever seeing the key. Questions whose blind answer
 * disagrees are dropped. Returns null when the check itself could not run
 * (in that case all questions are kept).
 */
async function verifyAnswers(questions, contexts, userId) {
  try {
    const payload = questions.map((question, index) => ({
      question_index: index + 1,
      question: question.question,
      options: question.options.map((option, optionIndex) => `(${optionIndex}) ${option}`),
    }));

    const raw = await chatJson({
      model: getVerifyModel(),
      temperature: 0,
      maxTokens: 2000,
      meta: { userId, purpose: 'verify_mcqs' },
      messages: [
        {
          role: 'system',
          content:
            'You are a careful medical exam taker. Answer every question using ONLY the provided passages. Return JSON only.',
        },
        {
          role: 'user',
          content: [
            fixedChaptersSection({
              bookTitle: 'Blind check',
              subject: 'Medicine',
              chapters: contexts.map((context, index) => ({
                title: context.title,
                number: index + 1,
                textWithMarkers: withPageMarkers(context.content, context.pageMap),
              })),
            }),
            '',
            'Questions (no answers are given). For each, choose the single best option:',
            JSON.stringify(payload),
            'Return JSON: {"answers":[{"question_index":1,"option_index":0}]}',
          ].join('\n'),
        },
      ],
    });

    const parsed = JSON.parse(raw.replace(/```(?:json)?/g, '').trim());
    if (!Array.isArray(parsed.answers)) return null;

    const chosen = new Map();
    for (const answer of parsed.answers) {
      if (Number.isInteger(answer?.question_index) && Number.isInteger(answer?.option_index)) {
        chosen.set(answer.question_index, answer.option_index);
      }
    }

    return questions.filter((question, index) => {
      const blind = chosen.get(index + 1);
      return blind === undefined || blind === question.correct_index;
    });
  } catch {
    return null;
  }
}

// ── generate-mcqs ────────────────────────────────────────────────────────────

/**
 * Generates questions for a set of chapters.
 * `addToSetId` appends to an existing quiz (large sets are built in chunks).
 * Returns { setId, count, total }.
 */
export async function generateMcqs({ userId, body }) {
  try {
    let ids = (
      Array.isArray(body.chapterIds) && body.chapterIds.length > 0
        ? body.chapterIds
        : body.chapterId
          ? [body.chapterId]
          : []
    ).filter((id) => typeof id === 'string' && id.length > 0);

    if (ids.length > MAX_CHAPTERS_PER_SET) {
      throw new HttpError(400, `Choose at most ${MAX_CHAPTERS_PER_SET} chapters per quiz.`);
    }

    const count = Math.min(Math.max(Math.round(body.count ?? 10), MIN_QUESTIONS), MAX_QUESTIONS);
    const difficulty = body.difficulty === 'easy' || body.difficulty === 'hard' ? body.difficulty : 'medium';
    const type = QUESTION_TYPES.includes(body.questionType) ? body.questionType : 'single_best_answer';

    // When adding to an existing quiz the set's chapters are authoritative and
    // positions continue after the questions already stored.
    const addToSetId = typeof body.addToSetId === 'string' ? body.addToSetId : null;
    let startPosition = 1;
    let targetSetId = null;

    if (addToSetId) {
      const existingSet = await one(
        'select id, user_id, chapter_id, chapter_ids from mcq_sets where id = $1',
        [addToSetId],
      );
      if (!existingSet || existingSet.user_id !== userId) {
        throw new HttpError(404, 'Quiz not found (or it is not yours).');
      }

      const setChapterIds = Array.isArray(existingSet.chapter_ids)
        ? existingSet.chapter_ids
        : existingSet.chapter_id
          ? [existingSet.chapter_id]
          : [];
      if (setChapterIds.length > 0) ids = setChapterIds;

      const lastRow = await one(
        'select position from mcqs where set_id = $1 order by position desc limit 1',
        [addToSetId],
      );
      startPosition = (lastRow?.position ?? 0) + 1;
      targetSetId = addToSetId;
    }

    if (ids.length === 0) {
      throw new HttpError(400, 'chapterIds (or chapterId) is required.');
    }

    const ordered = await loadChapterContexts(userId, ids);

    const [targetExam, existingStems] = await Promise.all([
      getTargetExam(userId),
      targetSetId
        ? query('select question from mcqs where set_id = $1 limit 80', [targetSetId]).then((r) =>
            r.rows.map((row) => row.question),
          )
        : query(
            `select m.question
               from mcqs m
               join mcq_sets s on s.id = m.set_id
              where s.user_id = $1 and s.chapter_id = any($2::uuid[])
              limit 60`,
            [userId, ids],
          ).then((r) => r.rows.map((row) => row.question)),
    ]);

    const perChapterLimit = Math.max(6000, Math.floor(TOTAL_PROMPT_CHAR_BUDGET / ordered.length));
    const contexts = ordered.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content.slice(0, Math.min(PER_CHAPTER_CHAR_CAP, perChapterLimit)),
      pageMap: row.page_map ?? null,
      firstPage: row.first_page ?? null,
      lastPage: row.last_page ?? null,
    }));

    const book = { title: ordered[0].book_title, subject: ordered[0].book_subject };
    const multiChapter = contexts.length > 1;

    const raw = await chatJson({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            fixedChaptersSection({
              bookTitle: book?.title ?? 'Unknown book',
              subject: book?.subject ?? 'Medicine',
              chapters: contexts.map((context, index) => ({
                title: context.title,
                number: index + 1,
                textWithMarkers: withPageMarkers(context.content, context.pageMap),
              })),
            }),
            '',
            requestSection({
              type,
              difficulty,
              count,
              targetExam,
              existingStems,
              multiChapter,
            }),
          ].join('\n'),
        },
      ],
      maxTokens: 12000,
      temperature: 0.5,
      meta: { userId, purpose: 'generate_mcqs' },
    });

    // ---- validate -----------------------------------------------------------
    const seen = new Set(existingStems.map((stem) => normalizeForMatch(stem).slice(0, 120)));
    const existingTokens = existingStems.map((stem) => tokenSet(stem));
    const acceptedTokens = [];
    const questions = [];

    for (const candidate of parseQuestions(raw)) {
      const question = validateQuestion(candidate, contexts, type);
      if (!question) continue;

      const key = normalizeForMatch(question.question).slice(0, 120);
      if (seen.has(key)) continue;

      // Near-duplicate check against stored and freshly generated stems.
      const tokens = tokenSet(question.question);
      const nearDuplicate = [...existingTokens, ...acceptedTokens].some(
        (other) => jaccard(tokens, other) >= NEAR_DUPLICATE_THRESHOLD,
      );
      if (nearDuplicate) continue;

      seen.add(key);
      acceptedTokens.push(tokens);
      questions.push(question);
      if (questions.length >= count) break;
    }

    if (questions.length === 0) {
      throw new HttpError(
        502,
        'The AI response did not pass our quality checks (every question needs a verifiable quote from the chapter). Please try again.',
      );
    }

    // ---- blind verification (a second, independent answer check) ------------
    const verified = await verifyAnswers(questions, contexts, userId);
    if (verified !== null) {
      if (verified.length === 0) {
        throw new HttpError(502, 'No question survived the independent answer check. Please try again.');
      }
      questions.length = 0;
      questions.push(...verified);
    }

    // ---- store --------------------------------------------------------------
    let setId = targetSetId;
    if (!setId) {
      const title = multiChapter
        ? `${book?.title ?? 'Book'} — Ch. ${ordered.map((row) => row.number).join(', ')} · ${questions.length} MCQs`
        : `${ordered[0].title} — ${questions.length} MCQs`;

      const set = await one(
        `insert into mcq_sets (chapter_id, chapter_ids, user_id, title, difficulty, status)
         values ($1, $2::uuid[], $3, $4, $5, 'ready') returning id`,
        [ordered[0].id, ids, userId, title, difficulty],
      );
      if (!set) throw new HttpError(500, 'Could not save the quiz. Please try again.');
      setId = set.id;
    }

    const rows = questions.map((question, index) => ({
      set_id: setId,
      position: startPosition + index,
      question: question.question,
      options: question.options,
      correct_index: question.correct_index,
      explanation: question.explanation,
      option_explanations: question.option_explanations,
      question_type: question.type,
      source_page: question.source_page,
      supporting_quote: question.supporting_quote,
      topic: question.topic ?? null,
      chapter_id: contexts[question.chapterIndex]?.id ?? ordered[0].id,
    }));

    try {
      await insertMcqs(rows);
    } catch (error) {
      if (!targetSetId && setId) {
        await query('delete from mcq_sets where id = $1', [setId]).catch(() => {});
      }
      throw new HttpError(500, `Could not save the questions: ${errorMessageOf(error)}`);
    }

    return {
      setId,
      count: rows.length,
      total: startPosition - 1 + rows.length,
    };
  } catch (error) {
    if (error instanceof MissingKeyError) throw new HttpError(500, error.message);
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, error instanceof Error && error.message ? error.message : 'Unexpected server error.');
  }
}

function errorMessageOf(error) {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

async function insertMcqs(rows) {
  const placeholders = [];
  const params = [];

  rows.forEach((row) => {
    const base = params.length;
    params.push(
      row.set_id,
      row.position,
      row.question,
      JSON.stringify(row.options),
      row.correct_index,
      row.explanation,
      JSON.stringify(row.option_explanations),
      row.question_type,
      row.source_page,
      row.supporting_quote,
      row.topic,
      row.chapter_id,
    );
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`,
    );
  });

  await query(
    `insert into mcqs
       (set_id, position, question, options, correct_index, explanation, option_explanations,
        question_type, source_page, supporting_quote, topic, chapter_id)
     values ${placeholders.join(', ')}`,
    params,
  );
}

// ── replace-question ─────────────────────────────────────────────────────────

const ATTEMPTS_IN_ONE_CALL = 3; // ask for a few; keep the first that validates

/**
 * Creates a fresh question to replace one the student flagged (the flagged one
 * is already hidden for them by their flag). Returns { mcqId }.
 */
export async function replaceQuestion({ userId, questionId }) {
  try {
    if (!questionId) throw new HttpError(400, 'questionId is required.');

    const questionRow = await one(
      `select m.id, m.set_id, m.chapter_id, m.question_type,
              s.user_id as set_user_id, s.chapter_id as set_chapter_id
         from mcqs m
         join mcq_sets s on s.id = m.set_id
        where m.id = $1`,
      [questionId],
    );

    if (!questionRow) throw new HttpError(404, 'Question not found (or it is not yours).');
    if (questionRow.set_user_id !== userId) {
      throw new HttpError(403, 'You can only replace questions in your own quizzes.');
    }

    const chapterId = questionRow.chapter_id ?? questionRow.set_chapter_id;
    if (!chapterId) throw new HttpError(400, 'This question has no chapter to rebuild it from.');

    const chapter = await one(
      `select c.id, c.title, c.content, c.page_map, c.first_page, c.last_page,
              b.title as book_title, b.subject as book_subject,
              (b.is_default or b.owner_id = $2) as can_access
         from chapters c
         join books b on b.id = c.book_id
        where c.id = $1`,
      [chapterId, userId],
    );
    if (!chapter || !chapter.can_access) {
      throw new HttpError(404, 'The chapter behind this question is no longer available.');
    }

    const [stemRows, targetExam] = await Promise.all([
      query('select id, question from mcqs where set_id = $1 limit 60', [questionRow.set_id]).then(
        (r) => r.rows,
      ),
      getTargetExam(userId),
    ]);

    const existingStems = stemRows
      .filter((row) => row.id !== questionId)
      .map((row) => row.question ?? '')
      .filter((stem) => stem.length > 0);

    const type = QUESTION_TYPES.includes(questionRow.question_type)
      ? questionRow.question_type
      : 'single_best_answer';

    const context = {
      id: chapter.id,
      title: chapter.title,
      content: chapter.content.slice(0, 16000),
      pageMap: chapter.page_map ?? null,
      firstPage: chapter.first_page ?? null,
      lastPage: chapter.last_page ?? null,
    };

    const raw = await chatJson({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            fixedChaptersSection({
              bookTitle: chapter.book_title ?? 'Unknown book',
              subject: chapter.book_subject ?? 'Medicine',
              chapters: [
                {
                  title: context.title,
                  number: 1,
                  textWithMarkers: withPageMarkers(context.content, context.pageMap),
                },
              ],
            }),
            '',
            requestSection({
              type,
              difficulty: 'medium',
              count: ATTEMPTS_IN_ONE_CALL,
              targetExam,
              existingStems,
              multiChapter: false,
            }),
          ].join('\n'),
        },
      ],
      maxTokens: 6000,
      temperature: 0.5,
      meta: { userId, purpose: 'replace_question' },
    });

    const seen = new Set(existingStems.map((stem) => normalizeForMatch(stem).slice(0, 120)));
    let replacement = null;

    for (const candidate of parseQuestions(raw)) {
      const question = validateQuestion(candidate, [context], type);
      if (!question) continue;
      const key = normalizeForMatch(question.question).slice(0, 120);
      if (seen.has(key)) continue;
      replacement = question;
      break;
    }

    if (!replacement) {
      throw new HttpError(502, 'Could not build a valid replacement question. Please try again.');
    }

    const lastRow = await one(
      'select position from mcqs where set_id = $1 order by position desc limit 1',
      [questionRow.set_id],
    );
    const position = (lastRow?.position ?? 0) + 1;

    const inserted = await one(
      `insert into mcqs
         (set_id, position, question, options, correct_index, explanation, option_explanations,
          question_type, source_page, supporting_quote, topic, chapter_id)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       returning id`,
      [
        questionRow.set_id,
        position,
        replacement.question,
        JSON.stringify(replacement.options),
        replacement.correct_index,
        replacement.explanation,
        JSON.stringify(replacement.option_explanations),
        replacement.type,
        replacement.source_page,
        replacement.supporting_quote,
        replacement.topic ?? null,
        chapter.id,
      ],
    );

    if (!inserted) throw new HttpError(500, 'Could not save the replacement question.');

    return { mcqId: inserted.id };
  } catch (error) {
    if (error instanceof MissingKeyError) throw new HttpError(500, error.message);
    if (error instanceof HttpError) throw error;
    throw new HttpError(500, error instanceof Error && error.message ? error.message : 'Unexpected server error.');
  }
}
