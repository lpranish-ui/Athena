-- ============================================================================
-- Athena — study tools + planner + AI cost log (run after 0004)
-- ============================================================================
-- - study_materials: generated flashcards / chapter summaries (per user+chapter)
-- - profiles.exam_date: drives the study planner
-- - ai_calls: usage + token log for cost monitoring
-- Idempotent — safe to run again.
-- ============================================================================

-- study planner: exam date
alter table public.profiles add column if not exists exam_date date;

-- flashcards + chapter summaries
create table if not exists public.study_materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  kind text not null check (kind in ('flashcards', 'summary')),
  content jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, chapter_id, kind)
);

create index if not exists study_materials_chapter_idx on public.study_materials (user_id, chapter_id);

alter table public.study_materials enable row level security;

drop policy if exists "study_materials_select_own" on public.study_materials;
create policy "study_materials_select_own" on public.study_materials
  for select using (user_id = auth.uid());

drop policy if exists "study_materials_insert_own" on public.study_materials;
create policy "study_materials_insert_own" on public.study_materials
  for insert with check (user_id = auth.uid());

drop policy if exists "study_materials_update_own" on public.study_materials;
create policy "study_materials_update_own" on public.study_materials
  for update using (user_id = auth.uid());

drop policy if exists "study_materials_delete_own" on public.study_materials;
create policy "study_materials_delete_own" on public.study_materials
  for delete using (user_id = auth.uid());

-- AI usage log: apps record every model call; admins read it via the dashboard
-- (service role) to watch cost. Users can only insert their own rows.
create table if not exists public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  purpose text not null,
  model text not null,
  prompt_tokens int,
  completion_tokens int,
  cache_hit_tokens int,
  created_at timestamptz not null default now()
);

create index if not exists ai_calls_created_idx on public.ai_calls (created_at desc);

alter table public.ai_calls enable row level security;

drop policy if exists "ai_calls_insert_own" on public.ai_calls;
create policy "ai_calls_insert_own" on public.ai_calls
  for insert to authenticated with check (user_id = auth.uid());

-- No select policy: only admins (service role) can read the cost log.
