create table if not exists study_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  track text not null default 'mbbs' check (track in ('mbbs','usmle','postgraduate')),
  goal text check (length(goal)<=160),
  syllabus_text text check (length(syllabus_text)<=20000),
  updated_at timestamptz not null default now()
);
create table if not exists syllabus_objectives (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  position integer not null check (position between 0 and 99),
  title text not null check (length(title) between 1 and 200),
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links)='array' and jsonb_array_length(links)<=5),
  updated_at timestamptz not null default now(),
  unique(user_id,position)
);
create table if not exists course_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  course_id text not null,
  pack_version text not null,
  concept_id text not null,
  question_id text,
  category text not null check (category in ('accuracy','source','unclear','other')),
  message text not null check (length(message) between 10 and 2000),
  status text not null default 'open' check (status in ('open','triaged','resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists course_reports_queue_idx on course_reports(status,created_at);
create table if not exists learning_events (
  user_id uuid not null references users(id) on delete cascade,
  event_name text not null check (event_name in ('plan_saved','session_started','session_completed')),
  event_key text not null,
  created_at timestamptz not null default now(),
  primary key(user_id,event_name,event_key)
);
create index if not exists learning_events_time_idx on learning_events(event_name,created_at);
