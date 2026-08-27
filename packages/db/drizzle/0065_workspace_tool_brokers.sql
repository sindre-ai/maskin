-- Tool broker: per-workspace toolkit provisioning, and per-actor broker identity.
--
-- WHY TWO TABLES. The backend the tool broker runs on has a fixed single
-- organization, so a Maskin workspace cannot map to a backend tenant. Workspace
-- separation comes from a toolkit per workspace (`workspace_tool_brokers`),
-- whose membership patterns admit only that workspace's own integrations.
--
-- Credentials are a different axis. The backend isolates connections per user at
-- its storage layer, and it refuses to mint an organization-level API key — every
-- key belongs to the user that created it. So each Maskin actor gets its own
-- backend identity and its own key (`tool_broker_actors`), rather than one shared
-- service credential. There is no impersonation mechanism, so this is the only
-- way per-user credential isolation is available to us at all.
--
-- The unique index on workspace_id is load-bearing rather than cosmetic: two
-- concurrent session launches must converge on one toolkit instead of silently
-- provisioning two. Same for actor_id — a second identity for one actor would
-- strand whichever key was written first, and the backend returns a key exactly
-- once, so the stranded one is unrecoverable.
--
-- api_key is stored encrypted by the application (same helper as integration
-- credentials); this column never holds plaintext.

CREATE TABLE IF NOT EXISTS "workspace_tool_brokers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"toolkit_slug" text NOT NULL,
	"toolkit_id" text NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_tool_brokers_workspace_uniq"
	ON "workspace_tool_brokers" ("workspace_id");

CREATE TABLE IF NOT EXISTS "tool_broker_actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"subject_id" text NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tool_broker_actors_actor_uniq"
	ON "tool_broker_actors" ("actor_id");

COMMENT ON COLUMN "tool_broker_actors"."api_key" IS
	'Encrypted at rest. The only broker credential persisted; the password used to mint it is discarded.';
