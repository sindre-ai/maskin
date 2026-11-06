-- Rollback for 0135_sessions_logs_unpruned_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The sweep (if still deployed) falls back to scanning sessions_prune_candidates_idx: slow again,
-- but correct.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_logs_unpruned_idx";
