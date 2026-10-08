-- Additive migration: existing accounts and version-zero sessions remain valid.
alter table users add column if not exists token_version int not null default 0;
alter table users add column if not exists email_verified_at timestamptz;

create table if not exists auth_action_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('password_reset','email_verification')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_action_tokens_user_idx on auth_action_tokens(user_id,purpose);
create index if not exists auth_action_tokens_expiry_idx on auth_action_tokens(expires_at);
