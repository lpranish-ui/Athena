import type { StudySession, StudyStep } from '../types/study';

export type StudyAnswerInput = { option_index?: number; confidence?: 'unsure' | 'okay' | 'confident' };
export interface PendingStudyStep { step_id: string; input: StudyAnswerInput; saved_at: string }
export interface CachedStudySession { session: StudySession; pending: PendingStudyStep[]; saved_at: string }
export type OfflineStudySession = StudySession & {
  offline?: { cached: boolean; saved_at: string; pending_steps: string[] };
};

export class OfflineStudyConflictError extends Error {
  readonly status = 409;
  constructor(message = 'This session has different answers saved on another device. Review the server progress before continuing.') {
    super(message); this.name = 'OfflineStudyConflictError';
  }
}

function sameAnswer(step: StudyStep, input: StudyAnswerInput): boolean {
  return step.type === 'lesson' || (step.answer?.option_index === input.option_index && step.answer?.confidence === input.confidence);
}

/** Pending choices are visible, but never marked graded or added to mastery. */
export function displayOfflineSession(cache: CachedStudySession, cached: boolean): OfflineStudySession {
  const pendingIds = new Set(cache.pending.map((item) => item.step_id));
  const steps = cache.session.steps.map((step) => {
    const pending = cache.pending.find((item) => item.step_id === step.id);
    return pending && step.type === 'question'
      ? { ...step, answer: { option_index: pending.input.option_index!, confidence: pending.input.confidence! } }
      : step;
  });
  const next = steps.findIndex((step) => !step.completed && !pendingIds.has(step.id));
  return {
    ...cache.session, steps, current_index: next < 0 ? steps.length : next,
    offline: { cached, saved_at: cache.saved_at, pending_steps: [...pendingIds] },
  };
}

export function enqueueStudyStep(cache: CachedStudySession, stepId: string, input: StudyAnswerInput, now = new Date().toISOString()): CachedStudySession {
  const step = cache.session.steps.find((item) => item.id === stepId);
  if (!step) throw new Error('This step is missing from the downloaded session. Reconnect and reload.');
  const existing = cache.pending.find((item) => item.step_id === stepId);
  if (existing) {
    if (existing.input.option_index !== input.option_index || existing.input.confidence !== input.confidence) throw new OfflineStudyConflictError('This answer is already saved locally. Sync it before changing progress.');
    return cache;
  }
  if (step.completed) {
    if (!sameAnswer(step, input)) throw new OfflineStudyConflictError();
    return cache;
  }
  if (displayOfflineSession(cache, true).steps[displayOfflineSession(cache, true).current_index]?.id !== stepId) {
    throw new OfflineStudyConflictError('Complete the earlier downloaded steps before continuing.');
  }
  if (step.type === 'question' && (!Number.isInteger(input.option_index) || input.option_index! < 0
    || input.option_index! >= (step.question?.options.length ?? 0) || !['unsure', 'okay', 'confident'].includes(input.confidence ?? ''))) {
    throw new Error('Choose an answer and confidence before saving.');
  }
  const answer = step.type === 'question' ? { option_index: input.option_index, confidence: input.confidence } : {};
  return { ...cache, pending: [...cache.pending, { step_id: stepId, input: answer, saved_at: now }], saved_at: now };
}

/** A lost POST response may already have been committed. Drop only matching
 * answers, and retain divergent choices for an explicit conflict decision. */
export function reconcileStudySteps(cache: CachedStudySession, server: StudySession): CachedStudySession {
  if (server.id !== cache.session.id) throw new OfflineStudyConflictError('The downloaded session does not match this account response.');
  const pending = cache.pending.filter((item) => {
    const step = server.steps.find((candidate) => candidate.id === item.step_id);
    if (!step) throw new OfflineStudyConflictError('The saved session content changed. Review server progress before continuing.');
    if (!step.completed) return true;
    if (!sameAnswer(step, item.input)) throw new OfflineStudyConflictError();
    return false;
  });
  return { session: server, pending, saved_at: new Date().toISOString() };
}

/** The create-session endpoint can return an existing session. Treat it like a
 * resume response so pending local choices are never overwritten by its snapshot. */
export function mergeFetchedStudySession(existing: CachedStudySession | null, session: StudySession): CachedStudySession {
  return existing ? reconcileStudySteps(existing, session)
    : { session, pending: [], saved_at: new Date().toISOString() };
}

export async function flushPendingStudySteps(
  cache: CachedStudySession,
  fetchLatest: () => Promise<StudySession>,
  submit: (item: PendingStudyStep) => Promise<StudySession>,
  persist: (value: CachedStudySession) => Promise<void>,
): Promise<CachedStudySession> {
  let current = reconcileStudySteps(cache, await fetchLatest());
  await persist(current);
  while (current.pending.length) {
    const item = current.pending[0];
    if (current.session.steps[current.session.current_index]?.id !== item.step_id) throw new OfflineStudyConflictError('The server is waiting for an earlier step. Reload server progress to continue.');
    current = reconcileStudySteps(current, await submit(item));
    await persist(current);
  }
  return current;
}
