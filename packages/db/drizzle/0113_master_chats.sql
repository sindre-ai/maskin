-- Master chats, phase 1 of the master 1-1 chat bet: one stored chat per (workspace, person, agent).
--
-- Additive only. A new table, nothing backfilled, no existing row or column touched, so existing
-- chats are never relabelled and a revert leaves nothing half moved. master_chats is not on the
-- hot-tables list (MIGRATIONS.md): it is written once per person and agent pair, on first use.
--
-- The primary key on the pair is what lets two concurrent first calls produce one chat: the second
-- insert hits ON CONFLICT and reads the winner. conversation_id is unique so one chat is never the
-- master of two pairs. Rows go with their conversation, workspace or actor.
-- Row-level security is switched on here because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0113_master_chats_down.sql.

CREATE TABLE IF NOT EXISTS "master_chats" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"human_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"agent_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "master_chats_workspace_id_human_id_agent_id_pk" PRIMARY KEY ("workspace_id", "human_id", "agent_id"),
	CONSTRAINT "master_chats_conversation_id_unique" UNIQUE ("conversation_id")
);
--> statement-breakpoint
ALTER TABLE "master_chats" ENABLE ROW LEVEL SECURITY;
