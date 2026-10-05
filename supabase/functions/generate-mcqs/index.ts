// ============================================================================
// Athena Edge Function: generate-mcqs
// ============================================================================
// Turns one or MORE chapters into a multiple-choice quiz using the DeepSeek
// API. All prompt building, quote verification and validation lives in
// ../_shared/questions.ts (shared with replace-question).
//
// Request  (POST, authenticated):
//   { chapterIds: string[] (1–8) | chapterId: string,
//     count?=10 (5–20), difficulty?='easy'|'medium'|'hard',
//     questionType?='single_best_answer'|'vignette'|'true_false' }
// Response: { setId, count }  or  { error }
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatJson, getVerifyModel, MissingKeyError } from '../_shared/ai.ts';
import { corsHeaders, errorMessage, jsonResponse } from '../_shared/cors.ts';
import {
  QUESTION_TYPES,
  SYSTEM_PROMPT,
  fixedChaptersSection,
  normalizeForMatch,
  parseQuestions,
  requestSection,
  validateQuestion,
  withPageMarkers,
  type ChapterContext,
  type GeneratedQuestion,
  type QuestionType,
} from '../_shared/questions.ts';

const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 20;
const MAX_CHAPTERS_PER_SET = 8;
const TOTAL_PROMPT_CHAR_BUDGET = 32000;
const PER_CHAPTER_CHAR_CAP = 16000;
const NEAR_DUPLICATE_THRESHOLD = 0.75;

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeForMatch(text)
      .split(' ')
      .filter((word) => word.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Blind check: a second, cheaper model answers each question from the same
 * passages without ever seeing the key. Questions whose blind answer
 * disagrees are dropped. Returns null when the check itself could not run
 * (in that case all questions are kept).
 */
async function verifyAnswers(
  questions: GeneratedQuestion[],
  contexts: ChapterContext[],
  meta: { client: unknown; userId: string },
): Promise<GeneratedQuestion[] | null> {
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
      meta: { client: meta.client, userId: meta.userId, purpose: 'verify_mcqs' },
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

    const parsed = JSON.parse(raw.replace(/```(?:json)?/g, '').trim()) as {
      answers?: { question_index?: number; option_index?: number }[];
    };
    if (!Array.isArray(parsed.answers)) return null;

    const chosen = new Map<number, number>();
    for (const answer of parsed.answers) {
      if (Number.isInteger(answer?.question_index) && Number.isInteger(answer?.option_index)) {
        chosen.set(answer.question_index as number, answer.option_index as number);
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

interface RequestBody {
  chapterId?: string;
  chapterIds?: string[];
  addToSetId?: string;
  count?: number;
  difficulty?: string;
  questionType?: string;
}

interface ChapterRow {
  id: string;
  title: string;
  number: number;
  content: string;
  page_map: unknown;
  first_page: number | null;
  last_page: number | null;
  book: { title: string; subject: string } | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } },
    );

    const { data: userData, error: userError } = await supabase.auth.getUser();
    const user = userData?.user;
    if (userError || !user) {
      return jsonResponse({ error: 'You must be signed in to generate a quiz.' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    let ids = (
      Array.isArray(body.chapterIds) && body.chapterIds.length > 0
        ? body.chapterIds
        : body.chapterId
          ? [body.chapterId]
          : []
    ).filter((id): id is string => typeof id === 'string' && id.length > 0);

    if (ids.length > MAX_CHAPTERS_PER_SET) {
      return jsonResponse(
        { error: `Choose at most ${MAX_CHAPTERS_PER_SET} chapters per quiz.` },
        400,
      );
    }

    const count = Math.min(Math.max(Math.round(body.count ?? 10), MIN_QUESTIONS), MAX_QUESTIONS);
    const difficulty =
      body.difficulty === 'easy' || body.difficulty === 'hard' ? body.difficulty : 'medium';
    const type: QuestionType = QUESTION_TYPES.includes(body.questionType as QuestionType)
      ? (body.questionType as QuestionType)
      : 'single_best_answer';

    // When adding to an existing quiz (large sets are built in 20-question
    // chunks), the set's chapters are authoritative and positions continue
    // after the questions already stored.
    const addToSetId = typeof body.addToSetId === 'string' ? body.addToSetId : null;
    let startPosition = 1;
    let targetSetId: string | null = null;

    if (addToSetId) {
      const { data: existingSet, error: setLookupError } = await supabase
        .from('mcq_sets')
        .select('id, user_id, chapter_id, chapter_ids')
        .eq('id', addToSetId)
        .single();

      if (setLookupError || !existingSet || existingSet.user_id !== user.id) {
        return jsonResponse({ error: 'Quiz not found (or it is not yours).' }, 404);
      }

      const setChapterIds = Array.isArray(existingSet.chapter_ids)
        ? (existingSet.chapter_ids as string[])
        : existingSet.chapter_id
          ? [existingSet.chapter_id as string]
          : [];
      if (setChapterIds.length > 0) ids = setChapterIds;

      const { data: lastRow } = await supabase
        .from('mcqs')
        .select('position')
        .eq('set_id', addToSetId)
        .order('position', { ascending: false })
        .limit(1)
        .maybeSingle();
      startPosition = ((lastRow as { position?: number } | null)?.position ?? 0) + 1;
      targetSetId = addToSetId;
    }

    if (ids.length === 0) {
      return jsonResponse({ error: 'chapterIds (or chapterId) is required.' }, 400);
    }

    // RLS guarantees the user can only read chapters they have access to.
    const { data: rows, error: chaptersError } = await supabase
      .from('chapters')
      .select(
        'id, title, number, content, page_map, first_page, last_page, book:books (title, subject)',
      )
      .in('id', ids);

    if (chaptersError) {
      return jsonResponse({ error: `Could not load chapters: ${chaptersError.message}` }, 500);
    }

    const byId = new Map((rows ?? []).map((row) => [(row as ChapterRow).id, row as ChapterRow]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((row): row is ChapterRow => row !== undefined);

    if (ordered.length !== ids.length) {
      return jsonResponse(
        { error: 'Some chapters were not found (or you cannot access them).' },
        404,
      );
    }

    const [profileResult, existingResult] = await Promise.all([
      supabase.from('profiles').select('target_exam').eq('id', user.id).maybeSingle(),
      targetSetId
        ? supabase.from('mcqs').select('question').eq('set_id', targetSetId).limit(80)
        : supabase
            .from('mcqs')
            .select('question, set:mcq_sets!inner(user_id, chapter_id)')
            .eq('set.user_id', user.id)
            .in('set.chapter_id', ids)
            .limit(60),
    ]);

    const targetExam = (profileResult.data?.target_exam as string | null) ?? null;
    const existingStems = (existingResult.data ?? [])
      .map((row) => (row as { question?: string }).question ?? '')
      .filter((stem) => stem.length > 0);

    const perChapterLimit = Math.max(
      6000,
      Math.floor(TOTAL_PROMPT_CHAR_BUDGET / ordered.length),
    );
    const contexts: ChapterContext[] = ordered.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content.slice(0, Math.min(PER_CHAPTER_CHAR_CAP, perChapterLimit)),
      pageMap: row.page_map ?? null,
      firstPage: row.first_page ?? null,
      lastPage: row.last_page ?? null,
    }));

    const book = ordered[0].book;
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
      meta: { client: supabase, userId: user.id, purpose: 'generate_mcqs' },
    });

    // ---- validate -----------------------------------------------------------
    const seen = new Set(existingStems.map((stem) => normalizeForMatch(stem).slice(0, 120)));
    const existingTokens = existingStems.map((stem) => tokenSet(stem));
    const acceptedTokens: Set<string>[] = [];
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
      return jsonResponse(
        {
          error:
            'The AI response did not pass our quality checks (every question needs a verifiable quote from the chapter). Please try again.',
        },
        502,
      );
    }

    // ---- blind verification (a second, independent answer check) ------------
    const verified = await verifyAnswers(questions, contexts, {
      client: supabase,
      userId: user.id,
    });
    if (verified !== null) {
      if (verified.length === 0) {
        return jsonResponse(
          { error: 'No question survived the independent answer check. Please try again.' },
          502,
        );
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

      const { data: set, error: setError } = await supabase
        .from('mcq_sets')
        .insert({
          chapter_id: ordered[0].id,
          chapter_ids: ids,
          user_id: user.id,
          title,
          difficulty,
          status: 'ready',
        })
        .select('id')
        .single();

      if (setError || !set) {
        return jsonResponse(
          { error: `Could not save the quiz: ${setError?.message ?? 'unknown error'}` },
          500,
        );
      }
      setId = set.id as string;
    }

    const mcqRows = questions.map((question, index) => ({
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

    const { error: mcqError } = await supabase.from('mcqs').insert(mcqRows);
    if (mcqError) {
      if (!targetSetId && setId) {
        await supabase.from('mcq_sets').delete().eq('id', setId);
      }
      return jsonResponse({ error: `Could not save the questions: ${mcqError.message}` }, 500);
    }

    return jsonResponse({
      setId,
      count: mcqRows.length,
      total: startPosition - 1 + mcqRows.length,
    });
  } catch (err) {
    if (err instanceof MissingKeyError) {
      return jsonResponse({ error: err.message }, 500);
    }
    return jsonResponse({ error: errorMessage(err, 'Unexpected server error.') }, 500);
  }
});
