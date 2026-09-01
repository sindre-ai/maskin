-- Per-agent toolkits.
--
-- A toolkit is default-deny and its membership is per tool, which makes it the
-- only place a per-TOOL boundary can actually be enforced: at our MCP proxy the
-- integration name exists only inside agent-authored JavaScript, so filtering
-- there is a hint rather than a boundary.
--
-- Until now there was exactly one toolkit per workspace, shared by every agent
-- (`workspace_tool_brokers_workspace_uniq`). Adding a nullable actor_id lets an
-- agent have its own, with NULL meaning the workspace-wide default that every
-- existing row already is.
--
-- The single-column unique index has to go, but it cannot simply be dropped:
-- `(workspace_id, actor_id)` would not preserve "at most one default per
-- workspace", because Postgres treats NULLs as distinct. So it becomes a partial
-- unique index on the NULL rows plus another on the non-NULL ones — the same
-- shape as tool_grants, and for the same reason.

ALTER TABLE workspace_tool_brokers
	ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES actors(id) ON DELETE CASCADE;

DROP INDEX IF EXISTS workspace_tool_brokers_workspace_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_tool_brokers_default_uniq
	ON workspace_tool_brokers (workspace_id)
	WHERE actor_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_tool_brokers_actor_uniq
	ON workspace_tool_brokers (workspace_id, actor_id)
	WHERE actor_id IS NOT NULL;
