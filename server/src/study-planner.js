import { HttpError } from './http.js';

export const emptyProgress = () => ({
  status: 'new', attempts: 0, correct_count: 0, distinct_correct: 0,
  consecutive_correct: 0, lesson_completed: false, last_reviewed_at: null, due_at: null,
  correct_question_ids: [], successful_dates: [], repair_question_ids: [],
  recent_results: [], question_attempts: {}, needs_repair: false,
});

export function validateDate(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${label} must be a calendar date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${label} must be a valid calendar date.`);
  }
  return value;
}

export function validateTimezone(value = 'UTC') {
  if (typeof value !== 'string' || value.length > 80) throw new HttpError(400, 'Choose a valid timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date()); }
  catch { throw new HttpError(400, 'Choose a valid timezone.'); }
  return value;
}

export function localDate(now, timezone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function requireToday(value, now, timezone) {
  const today = localDate(now, timezone);
  if (value !== undefined && validateDate(value) !== today) {
    throw new HttpError(400, `Use today's date (${today}) in your study timezone.`);
  }
  return today;
}

export function publicProgress(progress) {
  const value = { ...emptyProgress(), ...progress };
  return Object.fromEntries(['status', 'attempts', 'correct_count', 'distinct_correct',
    'consecutive_correct', 'lesson_completed', 'last_reviewed_at', 'due_at'].map((key) => [key, value[key]]));
}

/** Coverage evidence, not an exam pass prediction. Same-item repeats do not earn distinct credit. */
export function recordAnswer(progress, questionId, correct, confidence, now, date) {
  const next = structuredClone({ ...emptyProgress(), ...progress });
  next.attempts++;
  next.correct_count += Number(correct);
  next.consecutive_correct = correct ? next.consecutive_correct + 1 : 0;
  next.recent_results = [...next.recent_results, correct].slice(-5);
  const prior = next.question_attempts[questionId] ?? { count: 0 };
  next.question_attempts[questionId] = { count: prior.count + 1, last_at: now.toISOString() };
  if (correct) {
    next.correct_question_ids = [...new Set([...next.correct_question_ids, questionId])];
    next.successful_dates = [...new Set([...next.successful_dates, date])];
    if (next.needs_repair) {
      next.repair_question_ids = [...new Set([...next.repair_question_ids, questionId])];
      if (next.repair_question_ids.length >= 2) next.needs_repair = false;
    }
  } else {
    next.needs_repair = true;
    next.repair_question_ids = [];
  }
  next.distinct_correct = next.correct_question_ids.length;
  next.status = next.needs_repair ? 'needs_review'
    : next.distinct_correct >= 2 && next.successful_dates.length >= 2
      && next.consecutive_correct >= 2 ? 'secure' : 'learning';
  next.last_reviewed_at = now.toISOString();
  const days = !correct || confidence === 'unsure' ? 1 : next.status === 'secure' ? 7 : 2;
  next.due_at = new Date(now.getTime() + days * 86_400_000).toISOString();
  return next;
}

export function courseSummary(pack) {
  return { id: pack.id, title: pack.title, subject: pack.subject, description: pack.description,
    version: pack.version, review_status: pack.review_status, review_note: pack.review_note,
    reviewed_by: pack.reviewed_by ?? null, reviewed_at: pack.reviewed_at ?? null,
    objective_count: pack.concepts.length,
    question_count: pack.concepts.reduce((sum, concept) => sum + concept.questions.length, 0) };
}

export function courseDetail(pack, progressById = {}) {
  return { ...courseSummary(pack), concepts: pack.concepts.map((concept) => ({
    id: concept.id, title: concept.title, objective: concept.objective, lesson: concept.lesson,
    key_points: concept.key_points, sources: concept.sources, estimated_minutes: concept.estimated_minutes,
    progress: publicProgress(progressById[concept.id]),
  })) };
}

export function rankedConcepts(pack, progressById, now, syllabusConceptIds = []) {
  const syllabus = new Set(syllabusConceptIds);
  return pack.concepts.map((concept, index) => {
    const progress = { ...emptyProgress(), ...progressById[concept.id] };
    const kind = progress.needs_repair ? 'repair'
      : progress.due_at && new Date(progress.due_at) <= now ? 'review'
        : !progress.lesson_completed ? 'new' : 'review';
    const priority = kind === 'repair' ? 0 : kind === 'review' && progress.due_at
      && new Date(progress.due_at) <= now ? 1 : kind === 'new' ? 2 : 3;
    return { concept, progress, kind, priority, index };
  }).sort((a, b) => a.priority - b.priority
    || (a.priority < 2 ? new Date(a.progress.due_at ?? 0) - new Date(b.progress.due_at ?? 0) : 0)
    || (a.priority >= 2 ? Number(syllabus.has(b.concept.id)) - Number(syllabus.has(a.concept.id)) : 0)
    || a.index - b.index);
}

/** Build private snapshots; the API serializer deliberately strips answer keys. */
export function planSession(pack, progressById, minutes, now, { examDate = null, today = null, syllabusConceptIds = [] } = {}) {
  const steps = [];
  const usedQuestions = new Set();
  let spent = 0;
  let ranked = rankedConcepts(pack, progressById, now, syllabusConceptIds);
  if (examDate && today) {
    const daysRemaining = Math.max(1, Math.ceil((new Date(`${examDate}T00:00:00Z`)
      - new Date(`${today}T00:00:00Z`)) / 86_400_000));
    if (daysRemaining <= 14) {
      // Preserve the first repair and due review, then make room for unpractised
      // objectives near an assessment. This adjusts coverage, not a pass forecast.
      const repairs = ranked.filter((entry) => entry.priority === 0);
      const due = ranked.filter((entry) => entry.priority === 1);
      const fresh = ranked.filter((entry) => entry.priority === 2);
      const quota = Math.min(3, Math.ceil(fresh.length / daysRemaining));
      ranked = [repairs[0], due[0], ...fresh.slice(0, quota), ...repairs.slice(1),
        ...due.slice(1), ...fresh.slice(quota), ...ranked.filter((entry) => entry.priority === 3)].filter(Boolean);
    }
  }
  const questionFor = ({ concept, progress }) => concept.questions
    .filter((question) => !usedQuestions.has(question.id))
    .map((question, index) => ({ question, index, history: progress.question_attempts[question.id] }))
    .sort((a, b) => (a.history?.count ?? 0) - (b.history?.count ?? 0)
      || (a.history && b.history ? new Date(a.history.last_at) - new Date(b.history.last_at) : 0)
      || a.index - b.index)[0]?.question;
  const add = (entry, type, kind, question) => {
    const estimated = type === 'lesson' ? (kind === 'repair' ? 2 : Math.min(6, entry.concept.estimated_minutes)) : 2;
    const step = { id: `step-${steps.length + 1}`, type, kind, concept_id: entry.concept.id,
      title: entry.concept.title, estimated_minutes: estimated, sources: entry.concept.sources };
    if (type === 'lesson') { step.lesson = entry.concept.lesson; step.key_points = entry.concept.key_points; }
    else { step.question_snapshot = structuredClone(question); usedQuestions.add(question.id); }
    steps.push(step); spent += estimated;
  };
  const focused = [];
  // Leave two minutes for a distinct exit question. Limit cognitive load to five concepts.
  for (const entry of ranked) {
    if (focused.length >= 5) break;
    const lessonCost = entry.kind === 'repair' ? 2 : entry.kind === 'new' ? Math.min(6, entry.concept.estimated_minutes) : 0;
    if (spent + lessonCost + 2 > minutes - 2) continue;
    const question = questionFor(entry);
    if (!question) continue;
    if (lessonCost) add(entry, 'lesson', entry.kind);
    add(entry, 'question', entry.kind, question);
    focused.push(entry);
  }
  const exitEntry = [...focused].reverse().find((entry) => questionFor(entry));
  if (exitEntry && spent + 2 <= minutes) add(exitEntry, 'question', 'exit', questionFor(exitEntry));
  if (!steps.length) throw new HttpError(422, 'This course cannot fit your study budget. Choose more minutes.');
  return steps;
}

export function serializeSession(row, answers = []) {
  const answerByStep = new Map(answers.map((answer) => [answer.step_id, answer]));
  const steps = row.steps.map((step) => {
    const answer = answerByStep.get(step.id);
    const publicStep = { id: step.id, type: step.type, kind: step.kind, concept_id: step.concept_id,
      title: step.title, estimated_minutes: step.estimated_minutes, sources: step.sources,
      completed: !!answer, feedback: answer?.feedback ?? null };
    if (step.type === 'lesson') { publicStep.lesson = step.lesson; publicStep.key_points = step.key_points; }
    else {
      publicStep.question = { id: step.question_snapshot.id, prompt: step.question_snapshot.prompt,
        options: step.question_snapshot.options };
      if (answer) publicStep.answer = { option_index: answer.option_index, confidence: answer.confidence };
    }
    return publicStep;
  });
  const completedQuestions = row.steps.filter((step) => step.type === 'question' && answerByStep.has(step.id));
  return { id: row.id, course_id: row.course_id, course_title: row.course_title,
    pack_version: row.pack_version, local_date: String(row.local_date).slice(0, 10),
    review_status: row.pack_snapshot?.review_status ?? 'draft',
    review_note: row.pack_snapshot?.review_note ?? 'Original draft pack. Editorial review pending.',
    reviewed_by: row.pack_snapshot?.reviewed_by ?? null, reviewed_at: row.pack_snapshot?.reviewed_at ?? null,
    daily_minutes: row.daily_minutes, status: row.status, steps,
    current_index: steps.findIndex((step) => !step.completed) === -1 ? steps.length : steps.findIndex((step) => !step.completed),
    estimated_minutes: steps.reduce((sum, step) => sum + step.estimated_minutes, 0),
    completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    summary: { questions_answered: completedQuestions.length,
      correct_answers: completedQuestions.filter((step) => answerByStep.get(step.id).correct).length,
      concepts_practiced: new Set(completedQuestions.map((step) => step.concept_id)).size } };
}
