import { api } from './apiClient';

export type StudyTrack = 'mbbs' | 'usmle' | 'postgraduate';

export interface StudyTrackInfo {
  id: StudyTrack;
  title: string;
  description: string;
  goals: string[];
}

export const STUDY_TRACKS: StudyTrackInfo[] = [
  {
    id: 'mbbs', title: 'MBBS',
    description: 'Connect university coursework and your syllabus to daily practice.',
    goals: ['Build preclinical foundations', 'Prepare for university assessments', 'Connect concepts before clinical study'],
  },
  {
    id: 'usmle', title: 'USMLE',
    description: 'Organize your foundations and clinical reasoning goals.',
    goals: ['Strengthen Step 1 foundations', 'Prepare for Step 2 CK reasoning', 'Repair weak concepts before an assessment'],
  },
  {
    id: 'postgraduate', title: 'Postgraduate entrance',
    description: 'Focus entrance exam revision on concepts and recurring mistakes.',
    goals: ['Revise for an entrance exam', 'Build a consistent question practice routine', 'Repair recurring mistakes during revision'],
  },
];

export const SHARED_PILOT_NOTE = 'All tracks currently share the draft Cardiovascular Foundations pilot. Choosing a track records your goal; it does not unlock exam-specific content or guarantee syllabus coverage.';
export const MAX_STUDY_GOAL_LENGTH = 160;
export const MAX_SYLLABUS_LENGTH = 20_000;

export interface StudyPreferences {
  track: StudyTrack;
  goal: string | null;
  syllabus_text: string | null;
  updated_at: string | null;
}

export type StudyPreferencesInput = Omit<StudyPreferences, 'updated_at'>;

export function getStudyTrack(track: StudyTrack): StudyTrackInfo {
  return STUDY_TRACKS.find((item) => item.id === track) || STUDY_TRACKS[0];
}

export const getStudyPreferences = () => api.get<StudyPreferences>('/api/study/preferences');

export const saveStudyPreferences = (input: StudyPreferencesInput) =>
  api.put<StudyPreferences>('/api/study/preferences', input);

export const importStudySyllabus = (text: string) =>
  api.post<unknown>('/api/study/syllabus/import', { text });

/** Keep import limits visible before a request replaces the objective map. */
export function syllabusImportError(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return 'Paste at least one learning objective before importing.';
  if (lines.length > 100) return 'Import up to 100 objectives at a time, one per line.';
  if (lines.some((line) => line.length > 200)) return 'Keep each objective to 200 characters or fewer. Split long lines into separate objectives.';
  return null;
}
