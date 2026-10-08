import type { CourseDetail, CourseEnrollment, CourseSummary, StudyDashboard, StudySession, StudyStepResponse } from '@/types/study';
import { api, apiRequest, ApiError, loadToken } from './apiClient';
import { privateOffline } from './privateOffline';
import { isOfflineNetworkError, type OfflineAccountLease } from './offlineStorage';
import { displayOfflineSession, enqueueStudyStep, flushPendingStudySteps, mergeFetchedStudySession, type CachedStudySession, type OfflineStudySession, type StudyAnswerInput } from './offlineStudy';

export function clientTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export interface StudyEnrollmentInput { course_id: string; daily_minutes: number; exam_date: string | null; timezone?: string }
export const getStudyCourses = () => api.get<CourseSummary[]>('/api/study/courses');
export const getStudyCourse = (courseId: string) => api.get<CourseDetail>(`/api/study/courses/${encodeURIComponent(courseId)}`);
export const saveStudyEnrollment = (input: StudyEnrollmentInput) => api.put<CourseEnrollment>('/api/study/enrollment', { ...input, timezone: input.timezone ?? clientTimeZone() });

const sessionPath = (id: string) => `study.sessions.${encodeURIComponent(id)}`;
const sessionUrl = (id: string) => `/api/study/sessions/${encodeURIComponent(id)}`;
const locks = new Map<string, Promise<unknown>>();
async function context() {
  const lease = privateOffline.lease();
  const token = await loadToken();
  privateOffline.assertCurrent(lease);
  return { lease, token };
}
function locked<T>(lease: OfflineAccountLease, id: string, action: () => Promise<T>): Promise<T> {
  const key = `${lease.accountId}:${lease.epoch}:${id}`;
  const task = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => {
    privateOffline.assertCurrent(lease);
    return action();
  });
  locks.set(key, task);
  void task.finally(() => { if (locks.get(key) === task) locks.delete(key); }).catch(() => undefined);
  return task;
}
function newCache(session: StudySession): CachedStudySession { return mergeFetchedStudySession(null, session); }
async function rejectInvalidCache(error: unknown, lease: OfflineAccountLease, path: string): Promise<never> {
  if (error instanceof ApiError && [401, 403, 404].includes(error.status) && privateOffline.current(lease)) {
    await privateOffline.remove(lease, [path]);
  }
  throw error;
}
function syncTimeout(deadline?: number): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ApiError(0, 'Sync paused to keep your plan responsive. Your answers remain saved locally.');
  return Math.min(5000, remaining);
}
async function syncCache(lease: OfflineAccountLease, token: string | null, id: string, cache: CachedStudySession, deadline?: number): Promise<CachedStudySession> {
  return flushPendingStudySteps(cache,
    async () => { const value = await apiRequest<StudySession>('GET', sessionUrl(id), { token, timeoutMs: syncTimeout(deadline) }); privateOffline.assertCurrent(lease); return value; },
    async (item) => {
      const value = await apiRequest<StudyStepResponse>('POST', `${sessionUrl(id)}/steps/${encodeURIComponent(item.step_id)}`, { body: item.input, token, timeoutMs: syncTimeout(deadline) });
      privateOffline.assertCurrent(lease); return value.session;
    },
    (value) => privateOffline.write(lease, sessionPath(id), value));
}

export async function getStudySession(id: string): Promise<OfflineStudySession> {
  const { lease, token } = await context();
  return locked(lease, id, async () => {
    const cached = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
    try {
      const value = cached
        ? await syncCache(lease, token, id, cached)
        : newCache(await api.get<StudySession>(sessionUrl(id), token));
      await privateOffline.write(lease, sessionPath(id), value);
      return displayOfflineSession(value, false);
    } catch (error) {
      if (isOfflineNetworkError(error)) {
        // Sync may have saved part of the queue before losing connectivity.
        const latest = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
        if (latest) return displayOfflineSession(latest, true);
      }
      return rejectInvalidCache(error, lease, sessionPath(id));
    }
  });
}
export const syncStudySession = getStudySession;

export async function getDownloadedStudySession(id: string): Promise<OfflineStudySession | null> {
  const lease = privateOffline.lease();
  const cache = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
  return cache ? displayOfflineSession(cache, true) : null;
}

/** Discarding pending choices requires an online, authoritative server copy. */
export async function discardPendingStudyProgress(id: string): Promise<OfflineStudySession> {
  const { lease, token } = await context();
  return locked(lease, id, async () => {
    const cache = newCache(await api.get<StudySession>(sessionUrl(id), token));
    await privateOffline.write(lease, sessionPath(id), cache);
    return displayOfflineSession(cache, false);
  });
}

export async function startStudySession(): Promise<OfflineStudySession> {
  const { lease, token } = await context();
  const session = await api.post<StudySession>('/api/study/sessions', {}, token);
  return locked(lease, session.id, async () => {
    const existing = await privateOffline.read<CachedStudySession>(lease, sessionPath(session.id));
    const cache = mergeFetchedStudySession(existing, session);
    await privateOffline.write(lease, sessionPath(session.id), cache);
    return displayOfflineSession(cache, false);
  });
}

export async function completeStudyStep(id: string, stepId: string, input: StudyAnswerInput = {}): Promise<StudyStepResponse & { queued?: boolean }> {
  const { lease, token } = await context();
  return locked(lease, id, async () => {
    let cache = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
    try {
      if (cache?.pending.length) cache = await syncCache(lease, token, id, cache);
      const response = await api.post<StudyStepResponse>(`${sessionUrl(id)}/steps/${encodeURIComponent(stepId)}`, input, token);
      cache = newCache(response.session);
      await privateOffline.write(lease, sessionPath(id), cache);
      return { ...response, session: displayOfflineSession(cache, false) };
    } catch (error) {
      if (isOfflineNetworkError(error)) {
        const latest = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
        if (latest) {
          const pending = enqueueStudyStep(latest, stepId, input);
          await privateOffline.write(lease, sessionPath(id), pending);
          return { session: displayOfflineSession(pending, true), feedback: null, queued: true };
        }
      }
      return rejectInvalidCache(error, lease, sessionPath(id));
    }
  });
}

export type OfflineStudyDashboard = StudyDashboard & { offline?: { cached: boolean; saved_at: string; pending_steps?: number; sync_message?: string } };
export async function getStudyDashboard(): Promise<OfflineStudyDashboard> {
  const { lease, token } = await context();
  try {
    let dashboard = await api.get<StudyDashboard>('/api/study/dashboard', token);
    let pending_steps = 0;
    let sync_message: string | undefined;
    let attemptedSync = false;
    // Sync today's downloaded work only after the API has proved reachable.
    // Both the lock wait and all requests share one bounded foreground budget.
    if (dashboard.today) {
      const id = dashboard.today.id;
      const cached = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
      pending_steps = cached?.pending.length ?? 0;
      if (cached?.pending.length) {
        attemptedSync = true;
        const deadline = Date.now() + 12000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const sync = locked(lease, id, async () => {
            const latest = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
            if (!latest?.pending.length) return;
            await syncCache(lease, token, id, latest, deadline);
          });
          await Promise.race([sync, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ApiError(0, 'Your remaining answers are saved locally. Open the session to finish syncing.')), 12000);
          })]);
          dashboard = await apiRequest<StudyDashboard>('GET', '/api/study/dashboard', { token, timeoutMs: syncTimeout(deadline) });
          pending_steps = 0;
        } catch (error) {
          privateOffline.assertCurrent(lease);
          if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
          if (error instanceof ApiError && error.status === 404) await privateOffline.remove(lease, [sessionPath(id)]);
          sync_message = error instanceof Error ? error.message : 'Open your saved session to finish syncing.';
          const latest = await privateOffline.read<CachedStudySession>(lease, sessionPath(id));
          pending_steps = latest?.pending.length ?? pending_steps;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    }
    const saved_at = new Date().toISOString();
    await privateOffline.write(lease, 'study.dashboard', { dashboard, saved_at });
    // Download today's full session, not just its summary, for later offline use.
    if (dashboard.today && !attemptedSync) {
      try {
        await locked(lease, dashboard.today.id, async () => {
          const path = sessionPath(dashboard.today!.id);
          const cached = await privateOffline.read<CachedStudySession>(lease, path);
          if (cached?.pending.length) return; // Preserve pending work; the session screen syncs it.
          const session = await apiRequest<StudySession>('GET', sessionUrl(dashboard.today!.id), { token, timeoutMs: 5000 });
          await privateOffline.write(lease, path, newCache(session));
        });
      } catch (error) {
        privateOffline.assertCurrent(lease);
        if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
        if (error instanceof ApiError && error.status === 404) await privateOffline.remove(lease, [sessionPath(dashboard.today.id)]);
        // A dashboard can still be shown if session prefetch fails.
      }
    }
    return { ...dashboard, offline: { cached: false, saved_at, pending_steps, sync_message } };
  } catch (error) {
    if (isOfflineNetworkError(error)) {
      const cached = await privateOffline.read<{ dashboard: StudyDashboard; saved_at: string }>(lease, 'study.dashboard');
      if (cached) {
        const session = cached.dashboard.today
          ? await privateOffline.read<CachedStudySession>(lease, sessionPath(cached.dashboard.today.id)) : null;
        return { ...cached.dashboard, offline: { cached: true, saved_at: cached.saved_at, pending_steps: session?.pending.length ?? 0 } };
      }
    }
    return rejectInvalidCache(error, lease, 'study.dashboard');
  }
}
