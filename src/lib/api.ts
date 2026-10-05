// Thin wrappers around the Athena edge functions + small data helpers.

import type { Difficulty, FlagReason, QuestionType, StudyContent } from '@/types';
import { supabase } from './supabase';

/** Pulls a friendly message out of a supabase.functions.invoke error. */
async function toUserMessage(error: unknown, fallback: string): Promise<string> {
  const candidate = error as {
    name?: string;
    message?: string;
    context?: { json?: () => Promise<unknown> };
  };

  if (candidate?.name === 'FunctionsHttpError' && candidate.context?.json) {
    try {
      const body = (await candidate.context.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through to the generic message
    }
  }

  if (candidate?.message) return candidate.message;
  return fallback;
}

interface GenerateInput {
  chapterIds: string[];
  count: number;
  difficulty: Difficulty;
  questionType: QuestionType;
}

interface GenerateResult {
  setId: string;
  count: number;
}

async function generateChunk(
  input: GenerateInput & { addToSetId?: string },
): Promise<GenerateResult> {
  const { data, error } = await supabase.functions.invoke('generate-mcqs', { body: input });

  if (error) {
    throw new Error(await toUserMessage(error, 'Quiz generation failed. Please try again.'));
  }
  if (data?.error) {
    throw new Error(data.error as string);
  }
  return data as GenerateResult;
}

const GENERATION_CHUNK = 20;

/**
 * Generates a quiz of any supported size (10 / 20 / 50). Large sets are built
 * in chunks of 20 questions — each chunk is one AI call, comfortably inside
 * the server's time limits — and appended to the same quiz.
 */
export async function generateQuiz(
  input: GenerateInput & { onProgress?: (done: number, total: number) => void },
): Promise<{ setId: string; count: number }> {
  const { onProgress, ...base } = input;

  let setId: string | null = null;
  let generated = 0;

  while (generated < base.count) {
    const chunk = Math.min(GENERATION_CHUNK, base.count - generated);
    const result = await generateChunk({
      ...base,
      count: chunk,
      ...(setId ? { addToSetId: setId } : {}),
    });

    setId = result.setId;
    generated += result.count;
    onProgress?.(Math.min(generated, base.count), base.count);

    if (result.count === 0) break; // safety: never loop forever
  }

  if (!setId || generated === 0) {
    throw new Error('Quiz generation failed. Please try again.');
  }
  return { setId, count: generated };
}

/** Creates a fresh question to replace one the student flagged. */
export async function replaceQuestion(questionId: string): Promise<{ mcqId: string }> {
  const { data, error } = await supabase.functions.invoke('replace-question', {
    body: { questionId },
  });

  if (error) {
    throw new Error(await toUserMessage(error, 'Could not create a replacement question.'));
  }
  if (data?.error) {
    throw new Error(data.error as string);
  }
  return data as { mcqId: string };
}

/** Generates a chapter summary or a flashcard deck (stored and reused). */
export async function generateStudyKit(input: {
  chapterId: string;
  kind: 'flashcards' | 'summary';
  count?: number;
}): Promise<StudyContent> {
  const { data, error } = await supabase.functions.invoke('study-kit', { body: input });

  if (error) {
    throw new Error(await toUserMessage(error, 'Could not create the study material.'));
  }
  if (data?.error) {
    throw new Error(data.error as string);
  }
  return (data as { content: StudyContent }).content;
}

export type IngestBookInput =
  | { mode: 'file'; bookId: string }
  | { mode: 'text'; title: string; subject: string; author?: string; text: string };

export async function ingestBook(
  input: IngestBookInput,
): Promise<{ bookId: string; chapters: number; queued?: boolean }> {
  const { data, error } = await supabase.functions.invoke('ingest-book', { body: input });

  if (error) {
    throw new Error(await toUserMessage(error, 'Could not process this book.'));
  }
  if (data?.error) {
    throw new Error(data.error as string);
  }
  return data as { bookId: string; chapters: number; queued?: boolean };
}

/** Deletes the signed-in user's account and all of their data. */
export async function deleteAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke('delete-account', { body: {} });

  if (error) {
    throw new Error(await toUserMessage(error, 'Could not delete your account.'));
  }
  if (data?.error) {
    throw new Error(data.error as string);
  }
}

/** Reports a question as wrong or unclear; it is hidden for this student afterwards. */
export async function flagQuestion(input: {
  questionId: string;
  reason: FlagReason;
  note?: string;
}): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const user = userData?.user;
  if (!user) throw new Error('You must be signed in.');

  const { error } = await supabase.from('flags').upsert(
    {
      question_id: input.questionId,
      user_id: user.id,
      reason: input.reason,
      note: input.note ?? null,
    },
    { onConflict: 'question_id,user_id' },
  );

  if (error) {
    throw new Error(`Could not send the report: ${error.message}`);
  }
}
