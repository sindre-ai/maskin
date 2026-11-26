-- YouTube approval gate (bet "YouTube integration", part 4, task "Every YouTube write waits for a
-- person"). Two new, empty tables in one file:
--
-- youtube_pending_actions: a write an agent asked for, held until a person approves it. payload is
-- the exact request, cleared when the action ends and never kept past 30 days (it may hold comment
-- text). claimed_at is set once by the executor in a conditional update, so an approved action runs
-- at most once. requested_by_actor, requested_by_session and approved_by carry no foreign key: they
-- are a record, so the account-deletion guard has nothing to chase. integration_id cascades, so
-- disconnecting a channel drops what was waiting on it.
--
-- youtube_action_audit: one row per decision, kept 12 months, ids and codes only. No foreign key to
-- the action or the integration, so the record outlives both. The safety line "no public action
-- without approval" reads this table.
--
-- New, empty tables, additive, neither on the hot-tables list (see MIGRATIONS.md), so plain DDL is
-- fine and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before these tables existed.
-- Down: drizzle/down/0167_youtube_pending_actions_down.sql.

CREATE TABLE IF NOT EXISTS "youtube_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"payload" jsonb,
	"payload_hash" text NOT NULL,
	"target_video_id" text,
	"channel_label" text,
	"agent_note" text,
	"requested_by_actor" uuid NOT NULL,
	"requested_by_session" uuid,
	"card_event_id" bigint,
	"status" text NOT NULL DEFAULT 'pending',
	"approved_by" uuid,
	"approved_payload_hash" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"result_code" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "youtube_pending_actions_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired', 'executed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "youtube_pending_actions_workspace_status_idx"
	ON "youtube_pending_actions" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "youtube_pending_actions_status_expires_idx"
	ON "youtube_pending_actions" USING btree ("status", "expires_at");
--> statement-breakpoint
ALTER TABLE "youtube_pending_actions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "youtube_action_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"pending_action_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"actor_id" uuid,
	"actor_type" text,
	"payload_hash" text,
	"result_code" text,
	"requested_by_session" uuid,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "youtube_action_audit_decision_check" CHECK ("decision" IN ('approved', 'rejected', 'expired', 'executed', 'failed', 'refused'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "youtube_action_audit_action_idx"
	ON "youtube_action_audit" USING btree ("pending_action_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "youtube_action_audit_workspace_created_idx"
	ON "youtube_action_audit" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
ALTER TABLE "youtube_action_audit" ENABLE ROW LEVEL SECURITY;
