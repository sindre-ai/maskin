-- "Has this workspace's budget summary for this day already been posted?" is asked for every
-- workspace on every tick of the daily-budget summary scheduler (every 10 minutes), by
-- services/daily-budget-events.ts:
--   WHERE workspace_id = $1 AND action = 'daily_budget_summary' AND data->>'day' = $2 LIMIT 1
-- Nothing indexed it, so each call read the workspace's events with no way to stop early when
-- there was no match: 336 ms on average, 6.4 s at worst, and only a 43% cache hit rate, so it also
-- pushed other queries' pages out of memory (208 calls, 70 s in the 2026-11-10 statistics).
--
-- Partial, so it holds one entry per workspace per day, a tiny slice of the table, and only a
-- budget summary event adds to it; every other event is untouched.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted
-- build; drop an INVALID leftover first.
-- Down: drizzle/down/0143_events_daily_budget_summary_day_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_daily_budget_summary_day_idx"
  ON "events" USING btree ("workspace_id", (("data" ->> 'day')))
  WHERE "action" = 'daily_budget_summary';
