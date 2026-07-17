-- One customer-owned Unipile LinkedIn account per workspace. Populated by the
-- Unipile hosted-auth callback (`GET /api/linkedin/callback`) after a customer
-- completes the per-account connect flow. Every downstream task on the
-- self-serve LinkedIn bet reads this row: the agent-detail UI (T4) renders
-- the sending-as identity and pacing counters from it, the Settings ›
-- Integrations row (T5) mirrors the same state, and the PostHog connect event
-- (T2) fires from the callback that writes into it.
--
-- The state enum is enforced by a CHECK rather than a Postgres enum so that
-- adding a new lifecycle value (e.g. `paused`) later is a plain migration
-- rewriting the constraint — no `ALTER TYPE ... ADD VALUE` inside a txn.
--
-- UNIQUE on workspace_id: one account per workspace by product decision (bet
-- `## Not doing` — no account-pool management, no multi-account switching).

CREATE TABLE IF NOT EXISTS "linkedin_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"state" text NOT NULL,
	"unipile_account_id" text,
	"sending_as_name" text,
	"sending_as_provider_id" text,
	"connected_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "linkedin_accounts_workspace_id_uniq" UNIQUE ("workspace_id"),
	CONSTRAINT "linkedin_accounts_state_check" CHECK (
		"state" IN ('handoff','syncing','warm_up','healthy','restricted','reconnect')
	)
);

ALTER TABLE "linkedin_accounts"
	DROP CONSTRAINT IF EXISTS "linkedin_accounts_workspace_id_workspaces_id_fk";
ALTER TABLE "linkedin_accounts"
	ADD CONSTRAINT "linkedin_accounts_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "linkedin_accounts"
	DROP CONSTRAINT IF EXISTS "linkedin_accounts_created_by_actors_id_fk";
ALTER TABLE "linkedin_accounts"
	ADD CONSTRAINT "linkedin_accounts_created_by_actors_id_fk"
	FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id")
	ON DELETE no action ON UPDATE no action;

-- ROLLBACK
-- The migrator (packages/db/src/migrate.ts) blindly applies every *.sql file
-- in this directory in alphabetical order, so adding a numbered rollback file
-- would auto-undo this on the next deploy. Run manually if needed:
--
-- DROP TABLE IF EXISTS "linkedin_accounts";
