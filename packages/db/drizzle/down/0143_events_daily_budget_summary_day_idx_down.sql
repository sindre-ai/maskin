-- Rollback for 0143_events_daily_budget_summary_day_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The daily-budget summary check still works without it, but goes back to reading the
-- workspace's events to find out that today's summary is not there yet: slower, never wrong.
DROP INDEX CONCURRENTLY IF EXISTS "events_daily_budget_summary_day_idx";
