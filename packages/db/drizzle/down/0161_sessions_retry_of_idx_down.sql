-- Rollback for 0161_sessions_retry_of_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Everything keeps working; agent deletes go back to scanning sessions per deleted row.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_retry_of_idx";
