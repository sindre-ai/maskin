-- Rollback for 0144_sessions_spawned_by_message_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Everything keeps working; spawned-session lookups and message deletes go back to scanning sessions.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_spawned_by_message_id_idx";
