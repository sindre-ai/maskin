-- Rollback for 0162_notifications_session_id_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Everything keeps working; agent deletes go back to scanning notifications per deleted session.
DROP INDEX CONCURRENTLY IF EXISTS "notifications_session_id_idx";
