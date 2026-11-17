-- One row per workspace, billing period and kind of mail sent when a workspace uses up its plan
-- (task "Email when a workspace uses up its plan").
--
-- Inserting the row is the claim: the unique constraint lets exactly one server instance send the
-- mail for a period, and a restart finds the row and sends nothing. A failed send deletes its own
-- claim so the next refusal can try again. kind is 'plan_used_up' for now; the check keeps a typo
-- from inventing a kind.
--
-- Rows go with the workspace (ON DELETE CASCADE). New, empty table, additive, not on the hot-tables
-- list (see MIGRATIONS.md), so plain DDL is fine and there is nothing to backfill. Nothing writes to
-- it until the plan-limit-email flag is on for a workspace. Row-level security is switched on
-- because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0163_plan_limit_emails_down.sql.

CREATE TABLE IF NOT EXISTS "plan_limit_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"period_end" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "plan_limit_emails_ws_period_kind_uniq" UNIQUE ("workspace_id", "period_end", "kind"),
	CONSTRAINT "plan_limit_emails_kind_check" CHECK ("kind" IN ('plan_used_up'))
);
--> statement-breakpoint
ALTER TABLE "plan_limit_emails" ENABLE ROW LEVEL SECURITY;
