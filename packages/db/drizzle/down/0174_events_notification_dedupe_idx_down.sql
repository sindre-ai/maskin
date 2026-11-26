-- Rollback for 0174_events_notification_dedupe_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The lookup keeps working without it, but goes back to the slow read: slower, never wrong.
DROP INDEX CONCURRENTLY IF EXISTS "events_notification_dedupe_idx";
