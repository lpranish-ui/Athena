-- ============================================================================
-- Athena — plan upgrades (run AFTER 0001_init.sql)
-- ============================================================================
-- Adds: profile country/target exam, book licensing + duplicate detection,
-- chapter page ranges, page-linked questions, flags, quiz modes.
-- Idempotent — safe to run again.
-- ============================================================================

-- profiles: country + target exam (drives question style)
alter table public.profiles add column if not exists country text;
alter table public.profiles add column if not exists target_exam text;

-- books: duplicate detection (file hash) + licensing record
alter table public.books add column if not exists file_hash text;
alter table public.books add column if not exists license text;
alter table public.books add column if not exists license_url text;

create index if not exists books_file_hash_idx on public.books (owner_id, file_hash);

-- chapters: printed page ranges + page -> character map (for page-linked questions)
alter table public.chapters add column if not exists first_page int;
alter table public.chapters add column if not exists last_page int;
alter table public.chapters add column if not exists page_map jsonb;

-- mcqs: question type, source page + supporting quote, per-option explanations
alter table public.mcqs add column if not exists question_type text not null default 'single_best_answer';
alter table public.mcqs add column if not exists source_page int;
alter table public.mcqs add column if not exists supporting_quote text;
alter table public.mcqs add column if not exists option_explanations jsonb;

-- quiz attempts: tutor / exam mode + duration
alter table public.quiz_attempts add column if not exists mode text not null default 'tutor';
alter table public.quiz_attempts add column if not exists duration_seconds int;

alter table public.quiz_attempts drop constraint if exists quiz_attempts_mode_check;
alter table public.quiz_attempts
  add constraint quiz_attempts_mode_check check (mode in ('tutor', 'exam'));

-- ----------------------------------------------------------------------------
-- flags: students report wrong or unclear questions; flagged questions are
-- hidden for that student on their next attempt.
-- ----------------------------------------------------------------------------
create table if not exists public.flags (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.mcqs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null default 'other',
  note text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  unique (question_id, user_id)
);

create index if not exists flags_user_idx on public.flags (user_id, created_at desc);
create index if not exists flags_question_idx on public.flags (question_id);

alter table public.flags enable row level security;

drop policy if exists "flags_select_own" on public.flags;
create policy "flags_select_own" on public.flags
  for select using (user_id = auth.uid());

drop policy if exists "flags_insert_own" on public.flags;
create policy "flags_insert_own" on public.flags
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.mcqs q
      join public.mcq_sets s on s.id = q.set_id
      where q.id = question_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "flags_update_own" on public.flags;
create policy "flags_update_own" on public.flags
  for update using (user_id = auth.uid());

drop policy if exists "flags_delete_own" on public.flags;
create policy "flags_delete_own" on public.flags
  for delete using (user_id = auth.uid());
