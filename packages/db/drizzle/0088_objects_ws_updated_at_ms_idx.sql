-- Expression index on objects (workspace_id, updated_at truncated to the
-- millisecond, in UTC). list_objects with sort=updatedAt orders, snapshots and
-- seeks on date_trunc('milliseconds', updated_at AT TIME ZONE 'UTC') so the
-- cursor (a millisecond JS Date) lines up with Postgres' microsecond column.
-- objects_ws_updated_at_idx cannot serve that ORDER BY, so without this index
-- every page scans and sorts the whole workspace (84 ms vs 0.2 ms at 100k rows).
--
-- The AT TIME ZONE 'UTC' cast is what makes the expression IMMUTABLE: date_trunc
-- on a bare timestamptz is only STABLE and Postgres refuses to index it. Queries
-- must repeat this exact expression for the planner to pick the index up.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_ws_updated_at_ms_idx"
	ON "objects" ("workspace_id", (date_trunc('milliseconds', "updated_at" AT TIME ZONE 'UTC')));
