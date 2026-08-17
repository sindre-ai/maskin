-- Multi-human, multi-agent chat: conversations, per-user participant state
-- (pin/archive/read), and messages. Additive only — sessions/session_logs
-- are untouched; an agent's reply to a conversation is still a normal
-- one-shot session (config.conversation links it back, see
-- sessionConversationContextSchema), the same shape as the existing
-- config.mention / config.thread_reply session-spawn patterns.

CREATE TABLE IF NOT EXISTS "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"title" text NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"last_message_at" timestamp with time zone NOT NULL DEFAULT now(),
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

-- Range-scan path for "my conversations ordered by last activity".
CREATE INDEX IF NOT EXISTS "conversations_ws_last_message_at_idx"
	ON "conversations" ("workspace_id", "last_message_at");

--> statement-breakpoint

-- Per-user pin/archive/read state lives here, not on conversations — two
-- humans in the same conversation can have independently pinned/archived/
-- read state. left_at is a soft-remove (not a DELETE) so a re-added
-- participant keeps their prior pin/archive/read history and a removed
-- participant keeps a stable author FK on their historical messages.
CREATE TABLE IF NOT EXISTS "conversation_participants" (
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"added_by" uuid REFERENCES "actors"("id"),
	"joined_at" timestamp with time zone NOT NULL DEFAULT now(),
	"left_at" timestamp with time zone,
	"pinned" boolean NOT NULL DEFAULT false,
	"archived" boolean NOT NULL DEFAULT false,
	"last_read_message_id" bigint,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "conversation_participants_conversation_id_actor_id_pk" PRIMARY KEY ("conversation_id", "actor_id")
);

--> statement-breakpoint

-- Leading column actor_id (reverse of the PK's leading column) — required
-- for "list my active conversations" to be an index scan.
CREATE INDEX IF NOT EXISTS "conversation_participants_actor_active_idx"
	ON "conversation_participants" ("actor_id", "conversation_id")
	WHERE "left_at" IS NULL;

--> statement-breakpoint

-- One row per chat turn, human- or agent-authored. session_id links an
-- agent-authored message back to the one-shot session that produced it
-- (NULL for human messages) — cost/token drill-down is a join at read
-- time, same nullable-FK-with-set-null shape as notifications.session_id
-- and agent_files.session_id. The unique constraint on session_id also
-- acts as the idempotency guard for the post_conversation_message MCP tool.
CREATE TABLE IF NOT EXISTS "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"kind" text NOT NULL DEFAULT 'message',
	"content" text NOT NULL,
	"metadata" jsonb,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "messages_session_id_uniq" UNIQUE ("session_id"),
	CONSTRAINT "messages_kind_check" CHECK ("kind" IN ('message', 'system'))
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "messages_conversation_id_idx"
	ON "messages" ("conversation_id", "id");
