-- Send permissions: how an agent's sends of one draft kind are treated (always_allow,
-- ask_first, deny). A row with a null agent_id is the workspace default for that kind; a row
-- with an agent is that agent's own setting and beats the default. The send gate reads it at
-- send time (the gate itself lands in a later change; until then nothing reads this table, so
-- every send still waits for a person exactly as before).
--
-- Starting settings, chosen by Sebastian on 4 Nov 2026: ask first for what reaches people
-- outside the company (email, LinkedIn message, connection request, InMail), always allow for
-- the rest (posts, comments, Slack). They are written as the workspace default of every
-- existing workspace, so the settings screen shows them. The same table is the fallback in
-- code (STARTING_SEND_MODES in packages/shared), for a workspace created after this.
--
-- New, empty-then-small table (a handful of rows per workspace), not on the hot-tables list
-- (see MIGRATIONS.md), so plain DDL and a single INSERT ... SELECT are fine. Row-level
-- security is switched on as for every table created after 0111_enable_rls_public_tables.
-- Down: drizzle/down/0131_send_permissions_down.sql.

CREATE TABLE IF NOT EXISTS "send_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"agent_id" uuid REFERENCES "actors"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"updated_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "send_permissions_mode_enum" CHECK ("mode" IN ('always_allow', 'ask_first', 'deny'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_permissions_agent_kind_uniq"
	ON "send_permissions" USING btree ("workspace_id", "agent_id", "kind")
	WHERE agent_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "send_permissions_default_kind_uniq"
	ON "send_permissions" USING btree ("workspace_id", "kind")
	WHERE agent_id IS NULL;
--> statement-breakpoint
ALTER TABLE "send_permissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO "send_permissions" ("workspace_id", "agent_id", "kind", "mode")
SELECT w."id", NULL, k."kind", k."mode"
FROM "workspaces" w
CROSS JOIN (VALUES
	('email', 'ask_first'),
	('linkedin_message', 'ask_first'),
	('linkedin_connection_request', 'ask_first'),
	('linkedin_inmail', 'ask_first'),
	('linkedin_post', 'always_allow'),
	('linkedin_comment', 'always_allow'),
	('linkedin_comment_reply', 'always_allow'),
	('linkedin_post_edit', 'always_allow'),
	('slack_message', 'always_allow')
) AS k("kind", "mode")
ON CONFLICT DO NOTHING;
