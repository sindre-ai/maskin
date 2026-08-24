-- Append-only audit + idempotency ledger for the prepaid usage-credits
-- balance cached at workspaces.settings.billing.credit_balance_cents.
-- 'topup' rows are written by the Stripe webhook (routes/stripe-webhook.ts)
-- when a mode:'payment' Checkout session completes, keyed idempotent on
-- stripe_checkout_session_id. 'debit' rows are written on maskin_plan
-- session completion (lib/credit-billing.ts) once a pro/team workspace over
-- its hard cap has a spendable balance, keyed idempotent on session_id.
--
-- Additive-only: brand-new, empty table, so no CONCURRENTLY/backfill dance
-- per MIGRATIONS.md (that rule is for indexes/columns added to tables with
-- live traffic).

CREATE TABLE IF NOT EXISTS "workspace_credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"balance_after_cents" integer NOT NULL,
	"stripe_checkout_session_id" text,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "workspace_credit_ledger"
	DROP CONSTRAINT IF EXISTS "workspace_credit_ledger_workspace_id_workspaces_id_fk";
ALTER TABLE "workspace_credit_ledger"
	ADD CONSTRAINT "workspace_credit_ledger_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "workspace_credit_ledger"
	DROP CONSTRAINT IF EXISTS "workspace_credit_ledger_session_id_sessions_id_fk";
ALTER TABLE "workspace_credit_ledger"
	ADD CONSTRAINT "workspace_credit_ledger_session_id_sessions_id_fk"
	FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id")
	ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_credit_ledger_topup_uniq"
	ON "workspace_credit_ledger" ("stripe_checkout_session_id")
	WHERE "type" = 'topup' AND "stripe_checkout_session_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_credit_ledger_debit_session_uniq"
	ON "workspace_credit_ledger" ("session_id")
	WHERE "type" = 'debit' AND "session_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "workspace_credit_ledger_workspace_created_idx"
	ON "workspace_credit_ledger" ("workspace_id", "created_at");
