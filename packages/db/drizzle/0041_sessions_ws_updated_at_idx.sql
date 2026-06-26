-- Composite (workspace_id, updated_at) index on sessions. Same shape and same
-- motivation as objects_ws_updated_at_idx (migration 0040): the watchdog
-- needs to ask "sessions not touched in 6h" without scanning the table.
--
-- `CREATE INDEX CONCURRENTLY` per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, `IF NOT EXISTS` for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_ws_updated_at_idx"
	ON "sessions" ("workspace_id", "updated_at");
