-- Aggregate library quotas: each book records its extracted-text size so
-- per-account and global storage sums stay cheap. Existing rows are backfilled
-- once at boot (see server/src/index.js).
alter table books add column if not exists total_chars bigint;
