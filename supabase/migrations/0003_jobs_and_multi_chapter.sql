-- ============================================================================
-- Athena — jobs queue, OCR handoff, multi-chapter quizzes (run after 0002)
-- ============================================================================
-- - books may now sit in a 'queued' state while the OCR worker processes them.
-- - mcq_sets can span several chapters (chapter_ids); each question records the
--   chapter it came from (mcqs.chapter_id).
-- - `jobs` is a simple Postgres queue polled by the Python worker.
-- Idempotent — safe to run again.
-- ============================================================================

-- books: allow the 'queued' status
alter table public.books drop constraint if exists books_status_check;
alter table public.books
  add constraint books_status_check check (status in ('processing', 'queued', 'ready', 'error'));

-- multi-chapter quiz sets
alter table public.mcq_sets alter column chapter_id drop not null;
alter table public.mcq_sets add column if not exists chapter_ids uuid[];
update public.mcq_sets
  set chapter_ids = array[chapter_id]
  where chapter_ids is null and chapter_id is not null;

-- per-question chapter provenance (questions survive chapter edits: set null)
alter table public.mcqs
  add column if not exists chapter_id uuid references public.chapters (id) on delete set null;
update public.mcqs q
  set chapter_id = s.chapter_id
  from public.mcq_sets s
  where q.set_id = s.id and q.chapter_id is null and s.chapter_id is not null;

-- ----------------------------------------------------------------------------
-- jobs: queue consumed by the Python worker (service role)
-- ----------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
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

create index if not exists jobs_queue_idx on public.jobs (status, created_at);
create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);

alter table public.jobs enable row level security;

-- Users may queue jobs and watch their status; only the worker (service role)
-- may update or delete them.
drop policy if exists "jobs_select_own" on public.jobs;
create policy "jobs_select_own" on public.jobs
  for select using (user_id = auth.uid());

drop policy if exists "jobs_insert_own" on public.jobs;
create policy "jobs_insert_own" on public.jobs
  for insert with check (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- claim_job(): atomically claims the oldest queued job for the worker.
-- Called with the service-role key; not callable by app users.
-- ----------------------------------------------------------------------------
create or replace function public.claim_job()
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.jobs;
begin
  update public.jobs
     set status = 'running',
         started_at = now(),
         attempts = attempts + 1
   where id = (
     select id
       from public.jobs
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

revoke execute on function public.claim_job() from public;
revoke execute on function public.claim_job() from anon;
revoke execute on function public.claim_job() from authenticated;
