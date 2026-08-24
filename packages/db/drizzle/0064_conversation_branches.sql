-- Conversation branching, backing the chat "rewind"/redo button.
--
-- Rewinding no longer appends a duplicate turn: it forks. The messages after
-- the rewind point stay on the parent branch and stay reachable through a
-- branch switcher, while `conversations.active_branch_id` says which branch is
-- currently live.
--
-- NULL is the root branch everywhere (messages.branch_id,
-- conversations.active_branch_id, sessions.branch_id). That is what makes this
-- migration a pure column-add with no backfill of `messages` — every existing
-- row is already correctly on the root branch.
CREATE TABLE IF NOT EXISTS "conversation_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"parent_branch_id" uuid,
	-- The message that was rewound to. EXCLUSIVE: on this branch, parent-branch
	-- messages with id >= forked_from_message_id are hidden. Deliberately not an
	-- FK to "messages" — that would close a declaration cycle, and messages
	-- already cascade-delete with the conversation.
	"forked_from_message_id" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_branches" ADD CONSTRAINT "conversation_branches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_branches" ADD CONSTRAINT "conversation_branches_parent_branch_id_conversation_branches_id_fk" FOREIGN KEY ("parent_branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_branches" ADD CONSTRAINT "conversation_branches_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Drives the branch switcher: "every branch forked at this message".
-- Plain (non-CONCURRENT) index is fine: the table is brand new and empty.
CREATE INDEX IF NOT EXISTS "conversation_branches_conv_forked_from_idx"
	ON "conversation_branches" ("conversation_id", "forked_from_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_branches_parent_idx"
	ON "conversation_branches" ("parent_branch_id");
--> statement-breakpoint
-- Nullable, no default, no NOT NULL: an ADD COLUMN with a constant-free default
-- would rewrite `messages`, which is on the synchronous path of every chat post.
ALTER TABLE "messages" ADD COLUMN "branch_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "active_branch_id" uuid;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_active_branch_id_conversation_branches_id_fk" FOREIGN KEY ("active_branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "branch_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_branch_id_conversation_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."conversation_branches"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- The uuid handed to the CLI via `--session-id`, so its transcript is
-- addressable for `--resume` without parsing the stream-json system/init line.
ALTER TABLE "sessions" ADD COLUMN "cli_session_id" uuid;
