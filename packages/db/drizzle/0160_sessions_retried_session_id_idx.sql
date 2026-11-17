-- Deleting an agent runs "delete from sessions where actor_id = $1" (DELETE /api/actors/:id). Every
-- deleted session row makes Postgres check the foreign keys that point at sessions. The self-reference
-- sessions.retried_session_id -> sessions.id had no index, so each deleted session scanned all of
-- sessions (about 186k rows). An agent with a few thousand sessions then hits the 2 min statement
-- timeout (Sentry MASKIN-DEV-1P, SQLSTATE 57014) and the delete never completes.
--
-- Partial on IS NOT NULL: only retried sessions have a value. Same shape as
-- sessions_spawned_by_session_id_idx (migration 0090).
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). If an interrupted build leaves an INVALID index, drop it
-- first. Down: drizzle/down/0160_sessions_retried_session_id_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_retried_session_id_idx"
  ON "sessions" USING btree ("retried_session_id")
  WHERE "retried_session_id" IS NOT NULL;
