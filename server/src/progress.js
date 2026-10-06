// Quiz analytics: turns stored attempts (with their question ids, topics and
// outcomes) into a progress overview — totals, accuracy per book, weak areas
// per topic and the most recent attempts. Pure and dependency-free so it can
// be unit-tested; the route feeds it rows from the database.

const MIN_TOPIC_ANSWERS = 2;
const RECENT_LIMIT = 8;

function ratio(correct, answered) {
  return answered > 0 ? correct / answered : 0;
}

export function summarizeProgress({ attempts = [], sets = [], questions = [] } = {}) {
  const setById = new Map(sets.map((set) => [set.id, set]));
  const questionById = new Map(questions.map((question) => [question.id, question]));

  const totals = { attempts: 0, answered: 0, correct: 0, seconds: 0 };
  const bookMap = new Map();
  const topicMap = new Map();
  const recent = [];

  for (const attempt of attempts) {
    totals.attempts += 1;
    totals.seconds += Number(attempt.duration_seconds) || 0;

    const set = setById.get(attempt.set_id);
    const bookTitle = set?.book_title ?? 'Unknown book';
    const book =
      bookMap.get(bookTitle) ?? { book_title: bookTitle, attempts: 0, answered: 0, correct: 0 };
    book.attempts += 1;

    const answers = Array.isArray(attempt.answers) ? attempt.answers : [];
    const ids = Array.isArray(attempt.question_ids) ? attempt.question_ids : [];

    answers.forEach((answer, index) => {
      const question = ids[index] ? questionById.get(ids[index]) : undefined;
      if (!question) return;
      const correct = Number(answer) === Number(question.correct_index);
      totals.answered += 1;
      book.answered += 1;
      if (correct) {
        totals.correct += 1;
        book.correct += 1;
      }
      if (question.topic) {
        const topic =
          topicMap.get(question.topic) ?? { topic: question.topic, answered: 0, correct: 0 };
        topic.answered += 1;
        if (correct) topic.correct += 1;
        topicMap.set(question.topic, topic);
      }
    });

    bookMap.set(bookTitle, book);
    if (recent.length < RECENT_LIMIT) {
      recent.push({
        set_title: set?.set_title ?? null,
        book_title: set?.book_title ?? null,
        score: Number(attempt.score) || 0,
        total: Number(attempt.total) || 0,
        mode: attempt.mode ?? 'tutor',
        completed_at: attempt.completed_at ?? null,
      });
    }
  }

  const books = [...bookMap.values()]
    .map((book) => ({ ...book, accuracy: ratio(book.correct, book.answered) }))
    .sort((a, b) => b.answered - a.answered || a.book_title.localeCompare(b.book_title));

  // Weakest topics first — the ones worth another pass.
  const topics = [...topicMap.values()]
    .filter((topic) => topic.answered >= MIN_TOPIC_ANSWERS)
    .map((topic) => ({ ...topic, accuracy: ratio(topic.correct, topic.answered) }))
    .sort((a, b) => a.accuracy - b.accuracy || b.answered - a.answered);

  return {
    totals: { ...totals, accuracy: ratio(totals.correct, totals.answered) },
    books,
    topics,
    recent,
  };
}

// ── study streaks ────────────────────────────────────────────────────────────

const STREAK_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

function dayKey(dateMs) {
  return new Date(dateMs).toISOString().slice(0, 10);
}

/**
 * Turns the distinct days with activity (quiz, review, reading, notes — as
 * 'YYYY-MM-DD' strings) into a streak summary. Pure so it can be unit-tested;
 * `today` is injected by the route so "now" stays out of the function.
 */
export function summarizeStreak({ activeDays = [], today } = {}) {
  const anchorMs = Date.parse(`${today}T00:00:00Z`);
  const active = new Set(
    activeDays.filter((day) => Number.isFinite(Date.parse(`${day}T00:00:00Z`))),
  );

  // Current streak: consecutive days ending today — or yesterday while today
  // is still open, so the flame does not reset before the day is over.
  let current = 0;
  let cursor = anchorMs;
  if (!active.has(dayKey(cursor))) cursor -= DAY_MS;
  while (Number.isFinite(cursor) && active.has(dayKey(cursor))) {
    current += 1;
    cursor -= DAY_MS;
  }

  // Best streak across everything on record.
  let best = 0;
  let run = 0;
  let previousMs = null;
  for (const day of [...active].sort()) {
    const ms = Date.parse(`${day}T00:00:00Z`);
    run = previousMs !== null && ms - previousMs === DAY_MS ? run + 1 : 1;
    if (run > best) best = run;
    previousMs = ms;
  }

  // The last two weeks, oldest first, for the little grid.
  const days = [];
  for (let offset = STREAK_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const ms = anchorMs - offset * DAY_MS;
    days.push({ day: dayKey(ms), active: active.has(dayKey(ms)) });
  }

  return {
    current,
    best: Math.max(best, current),
    activeToday: active.has(dayKey(anchorMs)),
    days,
  };
}
