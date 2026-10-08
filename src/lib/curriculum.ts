import { api } from './apiClient';

export interface SyllabusLink {
  course_id: string;
  concept_id: string;
  concept_title: string;
  progress_status?: 'new' | 'learning' | 'needs_review' | 'secure';
}
export interface SyllabusMap {
  items: { id: string; title: string; links: SyllabusLink[]; suggestions: SyllabusLink[]; status: 'mapped' | 'unmapped' }[];
  available_concepts: SyllabusLink[];
  summary: { total: number; mapped: number; unmapped: number };
  updated_at: string | null;
}
export const getSyllabus = () => api.get<SyllabusMap>('/api/study/syllabus');
export const importSyllabus = (text: string) => api.post<SyllabusMap>('/api/study/syllabus/import', { text });
export const saveSyllabusLinks = (id: string, links: SyllabusLink[]) => api.put<SyllabusMap>(
  `/api/study/syllabus/${encodeURIComponent(id)}`, { links: links.map(({ course_id, concept_id }) => ({ course_id, concept_id })) },
);
