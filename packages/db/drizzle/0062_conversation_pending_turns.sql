-- Chat turns that arrive while an agent's interactive conversation session is
-- still booting (pending/starting/queued) are buffered here by the
-- conversation responder instead of being dropped, then drained via
-- writeInput once the session's stdin attaches — see
-- SessionManager.drainPendingConversationTurns.
CREATE TABLE IF NOT EXISTS "conversation_pending_turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"message_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_pending_turns" ADD CONSTRAINT "conversation_pending_turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_pending_turns" ADD CONSTRAINT "conversation_pending_turns_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_pending_turns" ADD CONSTRAINT "conversation_pending_turns_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Idempotency: one buffered turn per (conversation, agent, message) — doubles
-- as the (conversation, agent) drain-lookup index. Plain (non-CONCURRENT)
-- index is fine: the table is brand new and empty.
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_pending_turns_conv_actor_msg_uniq"
	ON "conversation_pending_turns" ("conversation_id", "actor_id", "message_id");
