-- Persistent AI budgets derive from the ai_calls usage log (no extra writes):
-- the limiter counts provider calls per user and globally over a sliding
-- window. This index keeps the per-user window count cheap.
create index if not exists ai_calls_user_window_idx on ai_calls (user_id, created_at desc);
