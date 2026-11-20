-- Rollback for 0167_events_self_started_trigger_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The cap on triggers made by self-started runs still works without it, but goes back to the slow
-- nested loop over the enabled triggers (6 to 15 seconds per call): slower, never wrong.
DROP INDEX CONCURRENTLY IF EXISTS "events_self_started_trigger_idx";
