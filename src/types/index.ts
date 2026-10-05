// Shared types for the Athena app.

export type Difficulty = 'easy' | 'medium' | 'hard';
export type BookStatus = 'processing' | 'queued' | 'ready' | 'error';
export type SetStatus = 'generating' | 'ready' | 'error';
export type QuestionType = 'single_best_answer' | 'vignette' | 'true_false';
export type QuizMode = 'tutor' | 'exam';
export type FlagReason = 'incorrect' | 'unclear' | 'duplicate' | 'other';

/** Maps a character offset in chapter content to the printed page it sits on. */
export interface PageMark {
  page: number;
  char_start: number;
}

export interface Profile {
  id: string;
  full_name: string | null;
  school: string | null;
  year_of_study: number | null;
  country: string | null;
  target_exam: string | null;
  exam_date: string | null;
  created_at: string;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  subject: string;
  description: string | null;
  cover_color: string | null;
  is_default: boolean;
  owner_id: string | null;
  file_path: string | null;
  file_type: string | null;
  file_hash: string | null;
  license: string | null;
  license_url: string | null;
  status: BookStatus;
  status_message: string | null;
  created_at: string;
}

export interface BookWithCounts extends Book {
  chapter_count: number;
}

export interface ChapterSummary {
  id: string;
  book_id: string;
  number: number;
  title: string;
  first_page: number | null;
  last_page: number | null;
}

export interface Chapter extends ChapterSummary {
  content: string;
  page_map: PageMark[] | null;
  created_at: string;
}

export interface McqSet {
  id: string;
  chapter_id: string | null;
  chapter_ids: string[] | null;
  user_id: string;
  title: string | null;
  difficulty: Difficulty;
  status: SetStatus;
  created_at: string;
}

export interface Mcq {
  id: string;
  set_id: string;
  chapter_id: string | null;
  position: number;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string | null;
  option_explanations: string[] | null;
  question_type: QuestionType;
  source_page: number | null;
  supporting_quote: string | null;
  topic: string | null;
}

export interface QuizAttempt {
  id: string;
  set_id: string;
  user_id: string;
  score: number;
  total: number;
  answers: number[] | null;
  mode: QuizMode;
  duration_seconds: number | null;
  completed_at: string;
}

export interface Review {
  id: string;
  user_id: string;
  question_id: string;
  due_at: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  last_reviewed_at: string | null;
  created_at: string;
}

export interface Flashcard {
  front: string;
  back: string;
  source_page: number | null;
  topic?: string;
}

export interface SummaryPoint {
  heading: string;
  detail: string;
  page: number | null;
}

export type StudyKind = 'flashcards' | 'summary';

export interface StudyContent {
  cards?: Flashcard[];
  overview?: string;
  points?: SummaryPoint[];
}

export interface StudyMaterial {
  id: string;
  user_id: string;
  chapter_id: string;
  kind: StudyKind;
  content: StudyContent;
  created_at: string;
}

export interface Flag {
  id: string;
  question_id: string;
  user_id: string;
  reason: FlagReason;
  note: string | null;
  status: string;
  created_at: string;
}

/** A quiz set joined with the chapter/book it came from and the user's attempts. */
export interface McqSetWithContext extends McqSet {
  chapter: {
    id: string;
    title: string;
    number: number;
    book: { id: string; title: string; subject: string } | null;
  } | null;
  attempts: Pick<QuizAttempt, 'id' | 'score' | 'total' | 'completed_at'>[];
}

/** A chapter joined with its parent book (used on the chapter screen). */
export interface ChapterWithBook extends Chapter {
  book: { id: string; title: string; subject: string } | null;
}
