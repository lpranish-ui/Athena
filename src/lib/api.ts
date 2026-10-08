// REST wrappers for the Athena API + small data helpers.
// (Replaces the old Supabase edge-function invoke helpers.)

import type { Difficulty, FlagReason, QuestionType, StudyContent } from '@/types';
import { api, apiRequest, ApiError } from './apiClient';

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

/** Server state for one durable generation job. */
export interface GenerationJob {
  id: string;
  kind: 'mcqs' | 'study_kit';
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string;
  error: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Queues a durable generation job (the worker keeps running if the app closes). */
async function enqueueGeneration(body: Record<string, unknown>): Promise<{ jobId: string }> {
  try {
    return await api.post<{ jobId: string }>('/api/ai/jobs', body);
  } catch (error) {
    throw new Error(toUserMessage(error, 'Could not start the generation. Please try again.'));
  }
}

/**
 * Polls one job until it finishes. Network blips are tolerated because the
 * job keeps running server-side; the timeout message points the student at
 * the background results instead of failing hard.
 */
async function waitForJob(
  jobId: string,
  { onStage }: { onStage?: (stage: string) => void } = {},
): Promise<GenerationJob> {
  const deadline = Date.now() + 15 * 60 * 1000;
  let delay = 1500;
  for (;;) {
    let job: GenerationJob;
    try {
      job = await apiRequest<GenerationJob>('GET', `/api/ai/jobs/${jobId}`, { timeoutMs: 20000 });
    } catch (error) {
      const offline = error instanceof ApiError && error.status === 0;
      if (!offline || Date.now() > deadline) {
        throw new Error(toUserMessage(error, 'Could not check the generation status.'));
      }
      await sleep(delay);
      delay = Math.min(5000, delay + 500);
      continue;
    }

    onStage?.(job.stage);
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new Error(job.error ?? 'Generation failed. Please try again.');
    if (Date.now() > deadline) {
      throw new Error(
        'This is taking longer than expected. It will finish in the background — check your quizzes shortly.',
      );
    }
    await sleep(delay);
    delay = Math.min(5000, delay + 500);
  }
}

const GENERATION_CHUNK = 20;

/**
 * Generates a quiz of any supported size (10 / 20 / 50) through durable
 * server-side jobs. Large sets are built in chunks of 20 questions — each
 * chunk is one job — and appended to the same quiz.
 */
export async function generateQuiz(
  input: GenerateInput & {
    onProgress?: (done: number, total: number) => void;
    onStage?: (stage: string) => void;
  },
): Promise<{ setId: string; count: number }> {
  const { onProgress, onStage, ...base } = input;

  let setId: string | null = null;
  let generated = 0;

  while (generated < base.count) {
    const chunk = Math.min(GENERATION_CHUNK, base.count - generated);
    const { jobId } = await enqueueGeneration({
      kind: 'mcqs',
      ...base,
      count: chunk,
      ...(setId ? { addToSetId: setId } : {}),
    });
    const job = await waitForJob(jobId, { onStage });
    const result = job.result as GenerateResult | null;
    if (!result?.setId) throw new Error('Generation finished without a quiz. Please try again.');

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

/**
 * Generates a chapter summary or a flashcard deck through a durable job
 * (stored and reused). Finishes server-side even if the app closes.
 */
export async function generateStudyKit(input: {
  chapterId: string;
  kind: 'flashcards' | 'summary';
  count?: number;
  onStage?: (stage: string) => void;
}): Promise<StudyContent> {
  const { jobId } = await enqueueGeneration({
    kind: 'study_kit',
    chapterId: input.chapterId,
    material: input.kind,
    ...(input.count != null ? { count: input.count } : {}),
  });
  const job = await waitForJob(jobId, { onStage: input.onStage });
  const result = job.result as { kind: string; content: StudyContent } | null;
  if (!result?.content) throw new Error('Could not create the study material. Please try again.');
  return result.content;
}

/** Jobs still queued or running — lets screens show recovery state. */
export async function listActiveGenerationJobs(): Promise<GenerationJob[]> {
  try {
    const response = await apiRequest<{ jobs: GenerationJob[] }>('GET', '/api/ai/jobs?active=1', {
      timeoutMs: 20000,
    });
    return response.jobs;
  } catch {
    return [];
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

// ── reading progress ────────────────────────────────────────────────────────

/** Where the student stopped reading in one book (null = not started). */
export interface ReadingProgress {
  chapter_id: string | null;
  offset_ratio: number;
  updated_at?: string;
}

/** One "continue reading" entry from GET /api/reading. */
export interface ReadingListItem {
  book_id: string;
  chapter_id: string | null;
  offset_ratio: number;
  updated_at: string;
  book_title: string;
  book_subject: string;
  book_author: string | null;
  chapter_number: number | null;
  chapter_title: string | null;
}

/** Loads the saved reading position for one book. */
export async function getReadingProgress(bookId: string): Promise<ReadingProgress | null> {
  try {
    return await api.get<ReadingProgress | null>(`/api/books/${bookId}/reading-progress`);
  } catch {
    return null;
  }
}

/** Saves the current reading position (best effort — never blocks reading). */
export async function saveReadingProgress(
  bookId: string,
  chapterId: string | null,
  offsetRatio: number,
): Promise<void> {
  try {
    await api.put(`/api/books/${bookId}/reading-progress`, {
      chapterId,
      offsetRatio: Math.min(Math.max(offsetRatio, 0), 1),
    });
  } catch {
    // Best effort — the reader keeps working even if offline.
  }
}

/** The most recently read books (for the "Continue reading" shelf). */
export async function getReadingList(): Promise<ReadingListItem[]> {
  try {
    return await api.get<ReadingListItem[]>('/api/reading');
  } catch {
    return [];
  }
}

// ── highlights & notes ──────────────────────────────────────────────────────

export interface ReaderNote {
  id: string;
  chapter_id: string;
  paragraph_index: number;
  kind: 'highlight' | 'note';
  text: string;
  note: string | null;
  color?: string | null;
  created_at?: string;
  chapter_number?: number;
  chapter_title?: string;
}

/** All highlights + notes the student saved in one book. */
export async function getReaderNotes(bookId: string): Promise<ReaderNote[]> {
  try {
    return await api.get<ReaderNote[]>(`/api/books/${bookId}/notes`);
  } catch {
    return [];
  }
}

/** Saves a highlight (or a note attached to a passage). */
export async function addReaderNote(
  bookId: string,
  input: {
    chapterId: string;
    paragraphIndex: number;
    kind: 'highlight' | 'note';
    text: string;
    note?: string;
    color?: string;
  },
): Promise<ReaderNote> {
  return api.post<ReaderNote>(`/api/books/${bookId}/notes`, input);
}

/** Removes a highlight/note. */
export async function deleteReaderNote(noteId: string): Promise<void> {
  await api.del(`/api/notes/${noteId}`);
}

/** One chapter that matched an in-book search for a word or phrase. */
export interface BookSearchHit {
  chapter_id: string;
  number: number;
  title: string;
  position: number;
  hits: number;
  snippet: string;
}

/** Searches every chapter of one book; one row per matching chapter. */
export async function searchBook(bookId: string, query: string): Promise<BookSearchHit[]> {
  const result = await api.get<{ query: string; results: BookSearchHit[] }>(
    `/api/books/${bookId}/search?q=${encodeURIComponent(query)}`,
  );
  return result.results;
}

/** One chapter the tutor used when answering a question. */
export interface BookAnswerSource {
  chapter_id: string;
  number: number;
  title: string;
}

/** A grounded answer from the book's own text, plus the chapters it drew on. */
export interface BookAnswer {
  answer: string;
  sources: BookAnswerSource[];
}

/** Asks a question about one book; the answer is built only from its text. */
export async function askBook(bookId: string, question: string): Promise<BookAnswer> {
  return api.post<BookAnswer>(`/api/books/${bookId}/ask`, { question });
}

/** One saved item across the whole library (for the "My notes" screen). */
export interface LibraryNote extends ReaderNote {
  book_id: string;
  book_title: string;
}

/** Every highlight/note the student has saved, newest first. */
export async function getAllNotes(): Promise<LibraryNote[]> {
  try {
    return await api.get<LibraryNote[]>('/api/notes');
  } catch {
    return [];
  }
}

// ── flashcard decks (spaced repetition) ─────────────────────────────────────

/** One book's deck with due counts, for the deck list. */
export interface FlashcardDeck {
  book_id: string;
  book_title: string;
  total: number;
  due: number;
  next_due: string | null;
}

/** A saved flashcard with its current review state. */
export interface DeckCard {
  id: string;
  book_id: string;
  chapter_id: string | null;
  front: string;
  back: string;
  topic: string | null;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  due_at: string;
  last_reviewed_at: string | null;
}

/** All of the student's decks (one per book with saved cards). */
export async function getDecks(): Promise<FlashcardDeck[]> {
  try {
    return await api.get<FlashcardDeck[]>('/api/decks');
  } catch {
    return [];
  }
}

/** Every card in one deck, due first. */
export async function getDeckCards(bookId: string): Promise<DeckCard[]> {
  return api.get<DeckCard[]>(`/api/decks/${bookId}/cards`);
}

/** Saves generated cards into the book's review deck (dedupes on front). */
export async function saveFlashcards(
  chapterId: string,
  cards: { front: string; back: string; topic?: string }[],
): Promise<{ saved: number }> {
  return api.post<{ saved: number }>('/api/flashcards', { chapterId, cards });
}

/** Stores the computed schedule after grading a card. */
export async function gradeCard(
  cardId: string,
  state: {
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    due_at: string;
    last_reviewed_at: string;
  },
): Promise<void> {
  await api.patch(`/api/flashcards/${cardId}`, state);
}

/** Removes one card from the deck. */
export async function deleteCard(cardId: string): Promise<void> {
  await api.del(`/api/flashcards/${cardId}`);
}

// ── progress dashboard ──────────────────────────────────────────────────────

/** Totals, per-book and per-topic accuracy plus recent attempts. */
export interface ProgressSummary {
  totals: { attempts: number; answered: number; correct: number; seconds: number; accuracy: number };
  books: {
    book_title: string;
    attempts: number;
    answered: number;
    correct: number;
    accuracy: number;
  }[];
  topics: { topic: string; answered: number; correct: number; accuracy: number }[];
  recent: {
    set_title: string | null;
    book_title: string | null;
    score: number;
    total: number;
    mode: string;
    completed_at: string | null;
  }[];
  streak: {
    current: number;
    best: number;
    activeToday: boolean;
    days: { day: string; active: boolean }[];
  };
}

/** Loads the progress dashboard (null when unavailable — never blocks a screen). */
export async function getProgress(): Promise<ProgressSummary | null> {
  try {
    return await api.get<ProgressSummary>('/api/progress');
  } catch {
    return null;
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
