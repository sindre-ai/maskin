-- Rollback for 0160_sessions_retried_session_id_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Everything keeps working; agent deletes go back to scanning sessions per deleted row.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_retried_session_id_idx";
