-- ============================================================================
-- Group study — live multiplayer quiz rooms + leaderboards.
-- ============================================================================
-- Applied automatically by the API on boot (it runs schema.sql, which now
-- includes these tables). Kept as a separate file for manual runs.
-- Safe to run multiple times.
-- ============================================================================

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
