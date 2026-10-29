-- Agent grants, round two.
--
-- 1. Levels are now none | read | read_write. "Write" alone made no sense (an agent that can
--    change something should be able to look at it first), so write becomes read_write. A
--    'none' row is an explicit "this agent gets nothing", which beats a read default: it is
--    how one agent is taken off an integration everyone else can read.
-- 2. agent_chat_grants: access to a saved credential for ONE conversation. "Allow in this
--    chat" on a card writes a row here instead of a permanent agent_grants row; the credential
--    reaches only sessions of that agent in that conversation, and the row goes with the chat.
-- Down: drizzle/down/0096_agent_grants_levels_and_chat_scope_down.sql.

UPDATE "agent_grants" SET "access" = 'read_write' WHERE "access" = 'write';
--> statement-breakpoint
ALTER TABLE "agent_grants" DROP CONSTRAINT IF EXISTS "agent_grants_access_enum";
--> statement-breakpoint
ALTER TABLE "agent_grants"
	ADD CONSTRAINT "agent_grants_access_enum" CHECK ("access" IN ('none', 'read', 'read_write'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_chat_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"created_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "agent_chat_grants_uniq" UNIQUE ("integration_id", "actor_id", "conversation_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_chat_grants_actor_conv_idx"
	ON "agent_chat_grants" ("actor_id", "conversation_id");
