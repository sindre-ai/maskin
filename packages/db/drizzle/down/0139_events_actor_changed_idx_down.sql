-- Rollback for 0139_events_actor_changed_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- GET /api/actors/:id/objects still works without it, but its "changed" lookup reads the
-- workspace's event history again: slow on a large workspace, never wrong.
DROP INDEX CONCURRENTLY IF EXISTS "events_actor_changed_idx";
