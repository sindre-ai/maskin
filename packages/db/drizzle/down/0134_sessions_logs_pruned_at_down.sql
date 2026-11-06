-- Rollback for 0134_sessions_logs_pruned_at.sql. Drops the column; the sweep (if still deployed)
-- would fail on it, so roll back the 0135 index and the code first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "sessions" DROP COLUMN IF EXISTS "logs_pruned_at";
