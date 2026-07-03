-- Composite (workspace_id, updated_at) index on objects. Powers the new
-- updated_before / updated_after filters on list_objects so the Workspace
-- Driver's sweeps can query directly for stalled work instead of fetching the
-- whole workspace and filtering in JS. Without this index the planner falls
-- back to a sequential scan once a workspace grows past a few thousand rows.
-- The leading workspace_id keeps every workspace's range scan independent.
--
-- `CREATE INDEX CONCURRENTLY` per packages/db/MIGRATIONS.md Rule 1: kept as
-- the only statement in this file so no future edit can wrap it in a BEGIN
-- and silently leave an INVALID index behind. `IF NOT EXISTS` makes a retry
-- safe if a previous CONCURRENTLY build was interrupted.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_ws_updated_at_idx"
	ON "objects" ("workspace_id", "updated_at");
