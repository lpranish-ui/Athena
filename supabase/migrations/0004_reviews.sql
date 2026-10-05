-- ============================================================================
-- Athena — spaced repetition (run after 0003)
-- ============================================================================
-- One row per (student, question) tracks simplified FSRS-style review state:
-- missed questions come back quickly; remembered ones stretch out.
-- Idempotent — safe to run again.
-- ============================================================================

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  question_id uuid not null references public.mcqs (id) on delete cascade,
  due_at timestamptz not null default now(),
  stability real not null default 0,
  difficulty real not null default 5,
  reps int not null default 0,
  lapses int not null default 0,
  last_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, question_id)
);

create index if not exists reviews_due_idx on public.reviews (user_id, due_at);

alter table public.reviews enable row level security;

drop policy if exists "reviews_select_own" on public.reviews;
create policy "reviews_select_own" on public.reviews
  for select using (user_id = auth.uid());

drop policy if exists "reviews_insert_own" on public.reviews;
create policy "reviews_insert_own" on public.reviews
  for insert with check (user_id = auth.uid());

drop policy if exists "reviews_update_own" on public.reviews;
create policy "reviews_update_own" on public.reviews
  for update using (user_id = auth.uid());

drop policy if exists "reviews_delete_own" on public.reviews;
create policy "reviews_delete_own" on public.reviews
  for delete using (user_id = auth.uid());
