-- ============================================================================
-- Athena — full database schema for plain PostgreSQL (Render Postgres).
-- ============================================================================
-- This replaces the five Supabase migrations (0001–0005) for the Render
-- deployment. There is no RLS and no auth.users table — accounts live in
-- `users` (email + password hash) and the API enforces ownership of rows.
--
-- Safe to run on a fresh database, and safe to run again (idempotent).
-- Run it once as the database owner:
--   psql "$DATABASE_URL" -f server/sql/schema.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- users + profiles (replaces Supabase Auth)
-- ----------------------------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists users_email_key on users (lower(email));

create table if not exists profiles (
  id uuid primary key references users (id) on delete cascade,
  full_name text,
  school text,
  year_of_study int,
  country text,
  target_exam text,
  exam_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- books: built-in (default) books and books uploaded by students
-- ----------------------------------------------------------------------------
create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  subject text not null default 'General',
  description text,
  cover_color text,
  is_default boolean not null default false,
  owner_id uuid references users (id) on delete cascade,
  file_path text,
  file_type text,
  file_hash text,
  license text,
  license_url text,
  status text not null default 'ready' check (status in ('processing', 'queued', 'ready', 'error')),
  status_message text,
  created_at timestamptz not null default now()
);

create index if not exists books_owner_idx on books (owner_id);
create index if not exists books_file_hash_idx on books (owner_id, file_hash);

-- ----------------------------------------------------------------------------
-- chapters: one book is split into readable chapters
-- ----------------------------------------------------------------------------
create table if not exists chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references books (id) on delete cascade,
  number int not null default 1,
  title text not null,
  content text not null,
  page_map jsonb,
  first_page int,
  last_page int,
  created_at timestamptz not null default now()
);

create index if not exists chapters_book_idx on chapters (book_id, number);

-- ----------------------------------------------------------------------------
-- mcq_sets: a quiz (may span several chapters) built from one or more of them
-- ----------------------------------------------------------------------------
create table if not exists mcq_sets (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid references chapters (id) on delete cascade,
  chapter_ids uuid[],
  user_id uuid not null references users (id) on delete cascade,
  title text,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  status text not null default 'ready' check (status in ('generating', 'ready', 'error')),
  created_at timestamptz not null default now()
);

create index if not exists mcq_sets_user_idx on mcq_sets (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- mcqs: the questions themselves (with page citations + verifiable quotes)
-- ----------------------------------------------------------------------------
create table if not exists mcqs (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references mcq_sets (id) on delete cascade,
  chapter_id uuid references chapters (id) on delete set null,
  position int not null default 1,
  question text not null,
  options jsonb not null,
  correct_index int not null,
  explanation text,
  option_explanations jsonb,
  question_type text not null default 'single_best_answer',
  source_page int,
  supporting_quote text,
  topic text,
  created_at timestamptz not null default now()
);

create index if not exists mcqs_set_idx on mcqs (set_id, position);

-- ----------------------------------------------------------------------------
-- quiz_attempts: every finished quiz run (score + mode + duration)
-- ----------------------------------------------------------------------------
create table if not exists quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references mcq_sets (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  score int not null,
  total int not null,
  answers jsonb,
  mode text not null default 'tutor' check (mode in ('tutor', 'exam')),
  duration_seconds int,
  completed_at timestamptz not null default now()
);

create index if not exists quiz_attempts_user_idx on quiz_attempts (user_id, completed_at desc);

-- ----------------------------------------------------------------------------
-- flags: questions a student reported (hidden for that student afterwards)
-- ----------------------------------------------------------------------------
create table if not exists flags (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references mcqs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  reason text not null,
  note text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  unique (question_id, user_id)
);

create index if not exists flags_user_idx on flags (user_id, created_at desc);

-- ----------------------------------------------------------------------------
-- reviews: spaced repetition state, per (student, question)
-- ----------------------------------------------------------------------------
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  question_id uuid not null references mcqs (id) on delete cascade,
  due_at timestamptz not null default now(),
  stability double precision not null default 0,
  difficulty double precision not null default 5,
  reps int not null default 0,
  lapses int not null default 0,
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, question_id)
);

create index if not exists reviews_due_idx on reviews (user_id, due_at);

-- ----------------------------------------------------------------------------
-- study_materials: generated flashcards / chapter summaries (per user+chapter)
-- ----------------------------------------------------------------------------
create table if not exists study_materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  chapter_id uuid not null references chapters (id) on delete cascade,
  kind text not null check (kind in ('flashcards', 'summary')),
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, chapter_id, kind)
);

create index if not exists study_materials_chapter_idx on study_materials (user_id, chapter_id);

-- ----------------------------------------------------------------------------
-- jobs: queue for the OCR worker (scanned PDFs)
-- ----------------------------------------------------------------------------
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  type text not null check (type in ('ingest_book', 'generate_mcqs')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  attempts int not null default 0,
  error text,
  result jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists jobs_queue_idx on jobs (status, created_at);
create index if not exists jobs_user_idx on jobs (user_id, created_at desc);

-- claim_job(): atomically claims the oldest queued job (used by the OCR worker).
create or replace function claim_job()
returns setof jobs
language plpgsql
as $$
declare
  claimed jobs;
begin
  update jobs
     set status = 'running',
         started_at = now(),
         attempts = attempts + 1
   where id = (
     select id
       from jobs
      where status = 'queued' and attempts < 3
      order by created_at
      for update skip locked
      limit 1
   )
  returning * into claimed;

  if claimed.id is not null then
    return next claimed;
  end if;
  return;
end;
$$;

-- ----------------------------------------------------------------------------
-- ai_calls: usage + token log for cost monitoring
-- ----------------------------------------------------------------------------
create table if not exists ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users (id) on delete set null,
  purpose text not null,
  model text not null,
  prompt_tokens int,
  completion_tokens int,
  cache_hit_tokens int,
  created_at timestamptz not null default now()
);

create index if not exists ai_calls_created_idx on ai_calls (created_at desc);

-- ----------------------------------------------------------------------------
-- group study: live multiplayer quiz rooms (same questions, fastest + best wins)
-- ----------------------------------------------------------------------------
create table if not exists group_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  host_id uuid not null references users (id) on delete cascade,
  set_id uuid not null references mcq_sets (id) on delete cascade,
  title text,
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  phase text not null default 'lobby' check (phase in ('lobby', 'question', 'reveal', 'done')),
  current_index int not null default 0,
  question_count int not null default 0,
  question_started_at timestamptz,
  question_ends_at timestamptz,
  reveal_ends_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists group_rooms_code_key on group_rooms (code);
create index if not exists group_rooms_host_idx on group_rooms (host_id, created_at desc);

create table if not exists group_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references group_rooms (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  name text not null,
  score int not null default 0,
  correct_count int not null default 0,
  total_ms bigint not null default 0,
  joined_at timestamptz not null default now(),
  unique (room_id, user_id)
);

create table if not exists group_answers (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references group_rooms (id) on delete cascade,
  player_id uuid not null references group_players (id) on delete cascade,
  question_id uuid not null references mcqs (id) on delete cascade,
  question_index int not null,
  option_index int,
  correct boolean not null default false,
  elapsed_ms int,
  answered_at timestamptz not null default now(),
  unique (room_id, player_id, question_index)
);

create index if not exists group_answers_room_idx on group_answers (room_id, question_index);

-- ----------------------------------------------------------------------------
-- reading_progress: where each student stopped reading in a book (per user)
-- ----------------------------------------------------------------------------
create table if not exists reading_progress (
  user_id uuid not null references users (id) on delete cascade,
  book_id uuid not null references books (id) on delete cascade,
  chapter_id uuid references chapters (id) on delete set null,
  offset_ratio real not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

create index if not exists reading_progress_user_idx on reading_progress (user_id, updated_at desc);

-- ----------------------------------------------------------------------------
-- reader_notes: highlights + personal notes saved while reading
-- ----------------------------------------------------------------------------
create table if not exists reader_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  book_id uuid not null references books (id) on delete cascade,
  chapter_id uuid not null references chapters (id) on delete cascade,
  paragraph_index int not null,
  kind text not null check (kind in ('highlight', 'note')),
  text text not null default '',
  note text,
  created_at timestamptz not null default now()
);

create index if not exists reader_notes_book_idx on reader_notes (user_id, book_id, created_at desc);

-- Highlight colors (gold default; older rows keep gold automatically).
alter table reader_notes add column if not exists color text not null default 'gold';
