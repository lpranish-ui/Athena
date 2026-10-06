// Spaced repetition scheduler — a simplified, FSRS-style algorithm.
//
// A missed question comes back fast (hours); each successful review stretches
// the interval (~2.3x, capped at 60 days) while failures shrink it and raise
// the question's difficulty. State is stored per (student, question) in the
// `reviews` table.

import type { Review } from '@/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STABILITY_DAYS = 60;
const MIN_STABILITY_DAYS = 0.2; // ≈ 5 hours — missed questions return same-day

export interface ReviewSchedule {
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  due_at: string;
  last_reviewed_at: string;
}

type ReviewState = Pick<Review, 'stability' | 'difficulty' | 'reps' | 'lapses'>;

export function scheduleReview(state: ReviewState | null, correct: boolean): ReviewSchedule {
  let stability = state?.stability ?? 0;
  let difficulty = state?.difficulty ?? 5;
  let reps = state?.reps ?? 0;
  let lapses = state?.lapses ?? 0;

  if (correct) {
    stability =
      stability === 0 ? 2 : Math.min(MAX_STABILITY_DAYS, stability * 2.3);
    difficulty = Math.max(1, difficulty - 0.3);
    reps += 1;
  } else {
    stability = Math.max(MIN_STABILITY_DAYS, stability === 0 ? MIN_STABILITY_DAYS : stability / 2.4);
    difficulty = Math.min(10, difficulty + 0.6);
    lapses += 1;
  }

  return {
    stability,
    difficulty,
    reps,
    lapses,
    due_at: new Date(Date.now() + stability * DAY_MS).toISOString(),
    last_reviewed_at: new Date().toISOString(),
  };
}

// ── flashcard decks: four-grade SM-2-lite ────────────────────────────────────

export type FlashcardGrade = 'again' | 'hard' | 'good' | 'easy';

export interface FlashcardState {
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
}

export interface FlashcardSchedule extends FlashcardState {
  due_at: string;
  last_reviewed_at: string;
}

const CARD_MAX_STABILITY_DAYS = 120;

/** Schedules one flashcard after a grade (Again shrinking, Easy stretching). */
export function scheduleCard(
  state: FlashcardState | null,
  grade: FlashcardGrade,
): FlashcardSchedule {
  let stability = state?.stability ?? 0;
  let difficulty = state?.difficulty ?? 5;
  const reps = (state?.reps ?? 0) + 1;
  let lapses = state?.lapses ?? 0;

  if (grade === 'again') {
    stability = Math.max(MIN_STABILITY_DAYS, stability === 0 ? MIN_STABILITY_DAYS : stability * 0.5);
    difficulty = Math.min(10, difficulty + 0.8);
    lapses += 1;
  } else if (grade === 'hard') {
    stability = Math.min(
      CARD_MAX_STABILITY_DAYS,
      stability === 0 ? 0.6 : Math.max(0.6, stability * 1.3),
    );
    difficulty = Math.min(10, difficulty + 0.2);
  } else if (grade === 'good') {
    stability = Math.min(CARD_MAX_STABILITY_DAYS, stability === 0 ? 2 : stability * 2.3);
    difficulty = Math.max(1, difficulty - 0.15);
  } else {
    stability = Math.min(CARD_MAX_STABILITY_DAYS, stability === 0 ? 4 : stability * 3.1);
    difficulty = Math.max(1, difficulty - 0.4);
  }

  return {
    stability,
    difficulty,
    reps,
    lapses,
    due_at: new Date(Date.now() + stability * DAY_MS).toISOString(),
    last_reviewed_at: new Date().toISOString(),
  };
}

/** Human label for the interval a grade would produce ("~2 d" / "5 h"). */
export function gradePreview(state: FlashcardState | null, grade: FlashcardGrade): string {
  const days = scheduleCard(state, grade).stability;
  if (days < 1) return `~${Math.max(1, Math.round(days * 24))} h`;
  return `~${Math.round(days)} d`;
}

/** Whether a stored due timestamp has arrived (kept out of components for lint). */
export function isDue(dueAt: string): boolean {
  return new Date(dueAt).getTime() <= Date.now();
}
