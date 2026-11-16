-- Second self-reference on sessions: sessions.retry_of -> sessions.id. Same problem as
-- 0160_sessions_retried_session_id_idx: no index, so every session deleted by an agent delete scans
-- all of sessions to prove nothing points at it. Partial on IS NOT NULL, since only retry sessions
-- carry a value.
--
-- Alone in its file (MIGRATIONS.md Rule 1). Down: drizzle/down/0161_sessions_retry_of_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_retry_of_idx"
  ON "sessions" USING btree ("retry_of")
  WHERE "retry_of" IS NOT NULL;
