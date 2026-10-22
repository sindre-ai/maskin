-- Partial index on sessions.spawned_by_session_id (added in 0089): only linked
-- helpers are indexed, which is a small slice of the table.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_spawned_by_session_id_idx"
	ON "sessions" ("spawned_by_session_id")
	WHERE "spawned_by_session_id" IS NOT NULL;
