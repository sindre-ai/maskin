-- Partial index on objects.active_session_id, WHERE NOT NULL.
--
-- Every session teardown runs `UPDATE objects SET active_session_id = NULL
-- WHERE active_session_id = $1` (~900k calls in production pg_stat_statements,
-- ~17ms each). There was no index on the column, so each one scanned the whole
-- objects table, which also churned the buffer cache. Partial because the
-- overwhelming majority of rows have no active session.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_active_session_idx"
	ON "objects" ("active_session_id")
	WHERE "active_session_id" IS NOT NULL;
