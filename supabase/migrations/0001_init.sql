-- ============================================================================
-- Athena — initial database schema
-- ============================================================================
-- How to apply: open the Supabase Dashboard → SQL Editor → New query, paste
-- this whole file and click Run. (Or use the CLI: `supabase db push`.)
-- The script is idempotent — it is safe to run it again.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- profiles: one row per user, created automatically on sign-up
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  school text,
  year_of_study int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- Automatically create a profile row for every new user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- books: built-in (default) books and books uploaded by students
-- ----------------------------------------------------------------------------
create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  subject text not null default 'General',
  description text,
  cover_color text,
  is_default boolean not null default false,
  owner_id uuid references auth.users (id) on delete cascade,
  file_path text,
  file_type text,
  status text not null default 'ready' check (status in ('processing', 'ready', 'error')),
  status_message text,
  created_at timestamptz not null default now()
);

create index if not exists books_owner_idx on public.books (owner_id);
create index if not exists books_subject_idx on public.books (subject);

alter table public.books enable row level security;

-- Everyone signed in can see built-in books; you also see your own uploads.
drop policy if exists "books_select" on public.books;
create policy "books_select" on public.books
  for select using (is_default or owner_id = auth.uid());

drop policy if exists "books_insert_own" on public.books;
create policy "books_insert_own" on public.books
  for insert with check (owner_id = auth.uid());

drop policy if exists "books_update_own" on public.books;
create policy "books_update_own" on public.books
  for update using (owner_id = auth.uid());

drop policy if exists "books_delete_own" on public.books;
create policy "books_delete_own" on public.books
  for delete using (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- chapters: the text of each chapter, split during book ingestion
-- ----------------------------------------------------------------------------
create table if not exists public.chapters (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  number int not null default 1,
  title text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chapters_book_idx on public.chapters (book_id);

alter table public.chapters enable row level security;

-- A chapter is visible when its book is visible (built-in book or own book).
drop policy if exists "chapters_select" on public.chapters;
create policy "chapters_select" on public.chapters
  for select using (
    exists (
      select 1 from public.books b
      where b.id = book_id and (b.is_default or b.owner_id = auth.uid())
    )
  );

drop policy if exists "chapters_insert_owner" on public.chapters;
create policy "chapters_insert_owner" on public.chapters
  for insert with check (
    exists (
      select 1 from public.books b
      where b.id = book_id and b.owner_id = auth.uid()
    )
  );

drop policy if exists "chapters_update_owner" on public.chapters;
create policy "chapters_update_owner" on public.chapters
  for update using (
    exists (
      select 1 from public.books b
      where b.id = book_id and b.owner_id = auth.uid()
    )
  );

drop policy if exists "chapters_delete_owner" on public.chapters;
create policy "chapters_delete_owner" on public.chapters
  for delete using (
    exists (
      select 1 from public.books b
      where b.id = book_id and b.owner_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- mcq_sets: one quiz generated from one chapter, owned by the user who made it
-- ----------------------------------------------------------------------------
create table if not exists public.mcq_sets (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  status text not null default 'ready' check (status in ('generating', 'ready', 'error')),
  created_at timestamptz not null default now()
);

create index if not exists mcq_sets_user_idx on public.mcq_sets (user_id, created_at desc);
create index if not exists mcq_sets_chapter_idx on public.mcq_sets (chapter_id);

alter table public.mcq_sets enable row level security;

drop policy if exists "mcq_sets_select_own" on public.mcq_sets;
create policy "mcq_sets_select_own" on public.mcq_sets
  for select using (user_id = auth.uid());

drop policy if exists "mcq_sets_insert_own" on public.mcq_sets;
create policy "mcq_sets_insert_own" on public.mcq_sets
  for insert with check (user_id = auth.uid());

drop policy if exists "mcq_sets_update_own" on public.mcq_sets;
create policy "mcq_sets_update_own" on public.mcq_sets
  for update using (user_id = auth.uid());

drop policy if exists "mcq_sets_delete_own" on public.mcq_sets;
create policy "mcq_sets_delete_own" on public.mcq_sets
  for delete using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- mcqs: the individual questions of a set
-- ----------------------------------------------------------------------------
create table if not exists public.mcqs (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.mcq_sets (id) on delete cascade,
  position int not null default 1,
  question text not null,
  options jsonb not null,
  correct_index int not null,
  explanation text,
  topic text,
  created_at timestamptz not null default now()
);

create index if not exists mcqs_set_idx on public.mcqs (set_id, position);

alter table public.mcqs enable row level security;

drop policy if exists "mcqs_select_own" on public.mcqs;
create policy "mcqs_select_own" on public.mcqs
  for select using (
    exists (
      select 1 from public.mcq_sets s
      where s.id = set_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "mcqs_insert_own" on public.mcqs;
create policy "mcqs_insert_own" on public.mcqs
  for insert with check (
    exists (
      select 1 from public.mcq_sets s
      where s.id = set_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "mcqs_delete_own" on public.mcqs;
create policy "mcqs_delete_own" on public.mcqs
  for delete using (
    exists (
      select 1 from public.mcq_sets s
      where s.id = set_id and s.user_id = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- quiz_attempts: results of finished quizzes
-- ----------------------------------------------------------------------------
create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.mcq_sets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  score int not null,
  total int not null,
  answers jsonb,
  completed_at timestamptz not null default now()
);

create index if not exists attempts_user_idx on public.quiz_attempts (user_id, completed_at desc);

alter table public.quiz_attempts enable row level security;

drop policy if exists "attempts_select_own" on public.quiz_attempts;
create policy "attempts_select_own" on public.quiz_attempts
  for select using (user_id = auth.uid());

drop policy if exists "attempts_insert_own" on public.quiz_attempts;
create policy "attempts_insert_own" on public.quiz_attempts
  for insert with check (user_id = auth.uid());

drop policy if exists "attempts_delete_own" on public.quiz_attempts;
create policy "attempts_delete_own" on public.quiz_attempts
  for delete using (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- storage: private bucket for uploaded book files
-- Files are stored under `{user_id}/{book_id}.{ext}` so users can only ever
-- read/write their own folder.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('books', 'books', false)
on conflict (id) do nothing;

drop policy if exists "books_files_select_own" on storage.objects;
create policy "books_files_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'books'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "books_files_insert_own" on storage.objects;
create policy "books_files_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'books'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "books_files_update_own" on storage.objects;
create policy "books_files_update_own" on storage.objects
  for update to authenticated using (
    bucket_id = 'books'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "books_files_delete_own" on storage.objects;
create policy "books_files_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'books'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
