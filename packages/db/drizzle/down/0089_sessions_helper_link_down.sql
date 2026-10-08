-- Rollback for 0089_sessions_helper_link.sql and 0090_sessions_spawned_by_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Revert the helper-return code first: it reads and writes these columns.
DROP INDEX IF EXISTS "sessions_spawned_by_session_id_idx";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "helper_returned_at";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "spawned_by_session_id";
