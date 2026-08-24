-- Idempotency ledger for Stripe metered overage billing. Once a pro/team
-- workspace with `billing.overage_enabled` exceeds its hard cap, each new
-- block of OVERAGE_BLOCK_TOKENS consumed claims a row here (unique per
-- workspace/period/block index) before the block is reported to Stripe as a
-- meter event. The claim-before-report ordering, mirrored on
-- webhook_deliveries, means a crash or retry between the claim and the
-- Stripe call can never double-charge — `reported_at IS NULL` marks a claim
-- whose Stripe report never confirmed, which the overage reconciler retries.
--
-- Additive-only: brand-new, empty table, so no CONCURRENTLY/backfill dance
-- per MIGRATIONS.md (that rule is for indexes/columns added to tables with
-- live traffic).

CREATE TABLE IF NOT EXISTS "workspace_overage_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_start" integer NOT NULL,
	"block_index" integer NOT NULL,
	"tokens_at_block" integer NOT NULL,
	"session_id" uuid,
	"stripe_meter_event_id" text,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_overage_usage_ws_period_block_uniq" UNIQUE ("workspace_id", "period_start", "block_index")
);

ALTER TABLE "workspace_overage_usage"
	DROP CONSTRAINT IF EXISTS "workspace_overage_usage_workspace_id_workspaces_id_fk";
ALTER TABLE "workspace_overage_usage"
	ADD CONSTRAINT "workspace_overage_usage_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "workspace_overage_usage"
	DROP CONSTRAINT IF EXISTS "workspace_overage_usage_session_id_sessions_id_fk";
ALTER TABLE "workspace_overage_usage"
	ADD CONSTRAINT "workspace_overage_usage_session_id_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id")
	ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "workspace_overage_usage_unreported_idx"
	ON "workspace_overage_usage" ("reported_at")
	WHERE "reported_at" IS NULL;
