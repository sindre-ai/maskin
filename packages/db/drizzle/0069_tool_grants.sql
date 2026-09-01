-- Per-agent tool scoping.
--
-- A workspace connects an integration once; each agent is granted it explicitly.
-- Before this, every agent in a workspace received every integration's MCP server
-- AND its credential, so an agent with no Slack tool still held the Slack token.
--
-- Two PARTIAL unique indexes rather than one over (workspace_id, actor_id,
-- integration_ref): Postgres treats NULLs as distinct, so a single index would
-- allow two workspace-level rows for the same integration — the "no default set"
-- state would silently become "two conflicting defaults".

CREATE TABLE IF NOT EXISTS tool_grants (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	-- NULL = the workspace-level ceiling for this integration.
	actor_id uuid REFERENCES actors(id) ON DELETE CASCADE,
	integration_ref text NOT NULL,
	mode text NOT NULL DEFAULT 'all',
	tools jsonb NOT NULL DEFAULT '[]'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT tool_grants_mode_check CHECK (mode IN ('all', 'read', 'custom'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tool_grants_workspace_uniq
	ON tool_grants (workspace_id, integration_ref)
	WHERE actor_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tool_grants_actor_uniq
	ON tool_grants (actor_id, integration_ref)
	WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tool_grants_actor_idx ON tool_grants (actor_id);

-- The tools an integration exposes, and whether each only reads.
--
-- Kept here rather than read from the broker: its tool list carries names and
-- descriptions but no read-only flag (measured), while the MCP servers themselves
-- declare one on 95% of tools. `read_only` is NULL where the server did not say —
-- those are shown as unclassified and never swept into a read-only grant, because
-- guessing from the tool's name disagreed with the declaration on ~1 tool in 9.

CREATE TABLE IF NOT EXISTS integration_tools (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
	integration_ref text NOT NULL,
	name text NOT NULL,
	description text,
	read_only boolean,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_tools_uniq
	ON integration_tools (workspace_id, integration_ref, name);

CREATE INDEX IF NOT EXISTS integration_tools_lookup_idx
	ON integration_tools (workspace_id, integration_ref);
