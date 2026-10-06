import type {
  CourseDetail,
  CourseEnrollment,
  CourseSummary,
  StudyDashboard,
  StudySession,
  StudyStepResponse,
} from '@/types/study';

import { api } from './apiClient';

export function clientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface StudyEnrollmentInput {
  course_id: string;
  daily_minutes: number;
  exam_date: string | null;
  timezone?: string;
}

export const getStudyCourses = () => api.get<CourseSummary[]>('/api/study/courses');

export const getStudyCourse = (courseId: string) =>
  api.get<CourseDetail>(`/api/study/courses/${encodeURIComponent(courseId)}`);

export const saveStudyEnrollment = (input: StudyEnrollmentInput) =>
  api.put<CourseEnrollment>('/api/study/enrollment', {
    ...input,
    timezone: input.timezone ?? clientTimeZone(),
  });

// The API uses the enrollment's timezone to select the current study day.
// Sending the device's date would be incorrect when a learner travels.
export const getStudyDashboard = () => api.get<StudyDashboard>('/api/study/dashboard');

export const startStudySession = () => api.post<StudySession>('/api/study/sessions', {});

export const getStudySession = (sessionId: string) =>
  api.get<StudySession>(`/api/study/sessions/${encodeURIComponent(sessionId)}`);

export const completeStudyStep = (
  sessionId: string,
  stepId: string,
  input: { option_index?: number; confidence?: 'unsure' | 'okay' | 'confident' } = {},
) => api.post<StudyStepResponse>(
  `/api/study/sessions/${encodeURIComponent(sessionId)}/steps/${encodeURIComponent(stepId)}`,
  input,
);
