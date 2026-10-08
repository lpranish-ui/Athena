export interface StudySource {
  title: string;
  url: string;
  section?: string;
}

export interface CourseSummary {
  id: string;
  title: string;
  subject: string;
  description: string;
  version: string;
  review_status: 'draft' | 'reviewed';
  review_note: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  objective_count: number;
  question_count: number;
}

export interface ConceptProgress {
  status: 'new' | 'learning' | 'needs_review' | 'secure';
  attempts: number;
  correct_count: number;
  distinct_correct: number;
  consecutive_correct: number;
  lesson_completed: boolean;
  last_reviewed_at: string | null;
  due_at: string | null;
}

export interface CourseConcept {
  id: string;
  title: string;
  objective: string;
  lesson: string;
  key_points: string[];
  sources: StudySource[];
  estimated_minutes: number;
  progress: ConceptProgress;
}

export interface CourseDetail extends CourseSummary {
  concepts: CourseConcept[];
}

export interface CourseEnrollment {
  course_id: string;
  daily_minutes: number;
  exam_date: string | null;
  timezone: string;
}

export interface StudyMistake {
  concept_id: string;
  concept_title: string;
  question: string;
  selected_option: string;
  correct_option: string;
  explanation: string;
  misconception: string;
  confidence: 'unsure' | 'okay' | 'confident';
  created_at: string;
  resolved: boolean;
  sources: StudySource[];
}

export interface StudyFeedback {
  correct: boolean;
  correct_index: number;
  explanation: string;
  misconception: string | null;
  sources: StudySource[];
}

export interface StudyStep {
  id: string;
  type: 'lesson' | 'question';
  kind: 'new' | 'review' | 'repair' | 'exit';
  concept_id: string;
  title: string;
  estimated_minutes: number;
  sources: StudySource[];
  lesson?: string;
  key_points?: string[];
  question?: { id: string; prompt: string; options: string[] };
  completed: boolean;
  feedback: StudyFeedback | null;
  answer?: {
    option_index: number;
    confidence: 'unsure' | 'okay' | 'confident';
  };
}

export interface StudySessionSummary {
  questions_answered: number;
  correct_answers: number;
  concepts_practiced: number;
}

export interface StudySession {
  id: string;
  course_id: string;
  course_title: string;
  pack_version: string;
  review_status?: 'draft' | 'reviewed';
  review_note?: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  local_date: string;
  daily_minutes: number;
  status: 'active' | 'completed';
  steps: StudyStep[];
  current_index: number;
  estimated_minutes: number;
  completed_at: string | null;
  summary: StudySessionSummary;
}

export interface StudyDashboard {
  local_date: string | null;
  enrollment: CourseEnrollment | null;
  course: CourseDetail | null;
  summary: {
    total_objectives: number;
    practiced_objectives: number;
    secure_objectives: number;
    due_concepts: number;
    completed_sessions: number;
  };
  today: {
    id: string;
    status: 'active' | 'completed';
    completed_steps: number;
    total_steps: number;
    estimated_minutes: number;
  } | null;
  recommended_concepts: { id: string; title: string; reason: string }[];
  mistakes: StudyMistake[];
  recent_sessions?: {
    id: string;
    local_date: string;
    status: 'active' | 'completed';
    completed_steps: number;
    total_steps: number;
    estimated_minutes: number;
  }[];
}

export interface StudyStepResponse {
  session: StudySession;
  feedback: StudyFeedback | null;
}
