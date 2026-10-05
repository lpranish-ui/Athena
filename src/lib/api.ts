// REST wrappers for the Athena API + small data helpers.
// (Replaces the old Supabase edge-function invoke helpers.)

import type { Difficulty, FlagReason, QuestionType, StudyContent } from '@/types';
import { api, ApiError } from './apiClient';

/** Pulls a friendly message out of an API error. */
function toUserMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
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
  try {
    return await api.post<GenerateResult>('/api/ai/generate-mcqs', input);
  } catch (error) {
    throw new Error(toUserMessage(error, 'Quiz generation failed. Please try again.'));
  }
}

const GENERATION_CHUNK = 20;

/**
 * Generates a quiz of any supported size (10 / 20 / 50). Large sets are built
 * in chunks of 20 questions — each chunk is one AI call — and appended to the
 * same quiz.
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
  try {
    return await api.post<{ mcqId: string }>('/api/ai/replace-question', { questionId });
  } catch (error) {
    throw new Error(toUserMessage(error, 'Could not create a replacement question.'));
  }
}

/** Generates a chapter summary or a flashcard deck (stored and reused). */
export async function generateStudyKit(input: {
  chapterId: string;
  kind: 'flashcards' | 'summary';
  count?: number;
}): Promise<StudyContent> {
  try {
    const result = await api.post<{ kind: string; content: StudyContent }>(
      '/api/ai/study-kit',
      input,
    );
    return result.content;
  } catch (error) {
    throw new Error(toUserMessage(error, 'Could not create the study material.'));
  }
}

/** Builds a book (and its chapters) from pasted text. */
export async function ingestBook(input: {
  title: string;
  subject: string;
  author?: string;
  text: string;
}): Promise<{ bookId: string; chapters: number }> {
  try {
    return await api.post<{ bookId: string; chapters: number }>('/api/ai/ingest-book', {
      mode: 'text',
      ...input,
    });
  } catch (error) {
    throw new Error(toUserMessage(error, 'Could not process this book.'));
  }
}

/** Deletes the signed-in user's account and all of their data. */
export async function deleteAccount(): Promise<void> {
  try {
    await api.del('/api/account');
  } catch (error) {
    throw new Error(toUserMessage(error, 'Could not delete your account.'));
  }
}

/** Reports a question as wrong or unclear; it is hidden for this student afterwards. */
export async function flagQuestion(input: {
  questionId: string;
  reason: FlagReason;
  note?: string;
}): Promise<void> {
  try {
    await api.post('/api/flags', {
      question_id: input.questionId,
      reason: input.reason,
      note: input.note ?? null,
    });
  } catch (error) {
    throw new Error(toUserMessage(error, 'Could not send the report.'));
  }
}
