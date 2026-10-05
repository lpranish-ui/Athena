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
