-- Durable AI generation queue: quiz sets and study material keep generating
-- even when the app closes, and live status/results wait until the student
-- returns. Workers lease one job at a time and retry transient failures.
create table if not exists generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('mcqs','study_kit')),
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  stage text not null default 'Waiting to start…',
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  attempts int not null default 0,
  lease_token uuid,
  lease_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists generation_jobs_user_idx on generation_jobs(user_id, created_at desc);
create index if not exists generation_jobs_queue_idx on generation_jobs(status, created_at);
