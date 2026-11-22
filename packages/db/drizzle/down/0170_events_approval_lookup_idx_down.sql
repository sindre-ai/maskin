-- Rollback for 0170_events_approval_lookup_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The approval lookups keep working without it, but go back to reading every event of the object:
-- slower, never wrong.
DROP INDEX CONCURRENTLY IF EXISTS "events_approval_lookup_idx";
