// ============================================================================
// Athena Edge Function: replace-question
// ============================================================================
// Creates a fresh question to replace one the student flagged (the flagged one
// is already hidden for them by the flags table). The replacement goes through
// the same quality pipeline and is appended to the same quiz set, so it shows
// up next time the student opens the quiz.
//
// Request  (POST, authenticated): { questionId: string }
// Response: { mcqId: string }  or  { error }
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';
import { chatJson, MissingKeyError } from '../_shared/ai.ts';
import { corsHeaders, errorMessage, jsonResponse } from '../_shared/cors.ts';
import {
    fixedChaptersSection,
    normalizeForMatch,
    parseQuestions,
    QUESTION_TYPES,
    requestSection,
    SYSTEM_PROMPT,
    validateQuestion,
    withPageMarkers,
    type ChapterContext,
    type QuestionType,
} from '../_shared/questions.ts';

const ATTEMPTS_IN_ONE_CALL = 3; // ask for a few; keep the first that validates

interface RequestBody {
  questionId?: string;
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
      return jsonResponse({ error: 'You must be signed in.' }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    if (!body.questionId) {
      return jsonResponse({ error: 'questionId is required.' }, 400);
    }

    const { data: questionRow, error: questionError } = await supabase
      .from('mcqs')
      .select('id, set_id, chapter_id, question_type, set:mcq_sets!inner(id, user_id, chapter_id)')
      .eq('id', body.questionId)
      .single();

    if (questionError || !questionRow) {
      return jsonResponse({ error: 'Question not found (or it is not yours).' }, 404);
    }

    const setRow = (questionRow as { set?: { id: string; user_id: string; chapter_id: string | null } }).set;
    if (!setRow || setRow.user_id !== user.id) {
      return jsonResponse({ error: 'You can only replace questions in your own quizzes.' }, 403);
    }

    const chapterId =
      (questionRow as { chapter_id?: string | null }).chapter_id ?? setRow.chapter_id;
    if (!chapterId) {
      return jsonResponse({ error: 'This question has no chapter to rebuild it from.' }, 400);
    }

    const { data: chapter, error: chapterError } = await supabase
      .from('chapters')
      .select('id, title, content, page_map, first_page, last_page, book:books (title, subject)')
      .eq('id', chapterId)
      .single();

    if (chapterError || !chapter) {
      return jsonResponse({ error: 'The chapter behind this question is no longer available.' }, 404);
    }

    const [{ data: stemRows }, { data: profileRow }] = await Promise.all([
      supabase.from('mcqs').select('id, question').eq('set_id', setRow.id).limit(60),
      supabase.from('profiles').select('target_exam').eq('id', user.id).maybeSingle(),
    ]);

    const existingStems = (stemRows ?? [])
      .filter((row) => (row as { id: string }).id !== body.questionId)
      .map((row) => (row as { question?: string }).question ?? '')
      .filter((stem) => stem.length > 0);

    const rawType = (questionRow as { question_type?: string }).question_type;
    const type: QuestionType = QUESTION_TYPES.includes(rawType as QuestionType)
      ? (rawType as QuestionType)
      : 'single_best_answer';

    const book = (chapter as { book?: { title: string; subject: string } | null }).book ?? null;
    const context: ChapterContext = {
      id: chapter.id as string,
      title: chapter.title as string,
      content: (chapter.content as string).slice(0, 16000),
      pageMap: (chapter as { page_map?: unknown }).page_map ?? null,
      firstPage: (chapter as { first_page?: number | null }).first_page ?? null,
      lastPage: (chapter as { last_page?: number | null }).last_page ?? null,
    };

    const raw = await chatJson({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            fixedChaptersSection({
              bookTitle: book?.title ?? 'Unknown book',
              subject: book?.subject ?? 'Medicine',
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
              targetExam: (profileRow?.target_exam as string | null) ?? null,
              existingStems,
              multiChapter: false,
            }),
          ].join('\n'),
        },
      ],
      maxTokens: 6000,
      temperature: 0.5,
      meta: { client: supabase, userId: user.id, purpose: 'replace_question' },
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
      return jsonResponse(
        { error: 'Could not build a valid replacement question. Please try again.' },
        502,
      );
    }

    const { data: lastRow } = await supabase
      .from('mcqs')
      .select('position')
      .eq('set_id', setRow.id)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle();
    const position = ((lastRow as { position?: number } | null)?.position ?? 0) + 1;

    const { data: inserted, error: insertError } = await supabase
      .from('mcqs')
      .insert({
        set_id: setRow.id,
        position,
        question: replacement.question,
        options: replacement.options,
        correct_index: replacement.correct_index,
        explanation: replacement.explanation,
        option_explanations: replacement.option_explanations,
        question_type: replacement.type,
        source_page: replacement.source_page,
        supporting_quote: replacement.supporting_quote,
        topic: replacement.topic ?? null,
        chapter_id: chapter.id,
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      return jsonResponse(
        { error: `Could not save the replacement: ${insertError?.message ?? 'unknown error'}` },
        500,
      );
    }

    return jsonResponse({ mcqId: inserted.id });
  } catch (err) {
    if (err instanceof MissingKeyError) {
      return jsonResponse({ error: err.message }, 500);
    }
    return jsonResponse({ error: errorMessage(err, 'Unexpected server error.') }, 500);
  }
});
