-- VAT-correct checkout, Task 1 (foundation): the `awaiting_vies` table
-- introduced by the parent bet (a9e19ca4). Task 1 SHIPS this schema; Task 2
-- (VAT webhook state machine) is the first path that ever writes to it, and
-- Task 3 (VIES scheduler primitive) reads from it in the T+2h reminder and
-- T+24h timeout sweeps.
--
-- Row-lifecycle-as-state (Architect fold-in): intentionally NO `status`
-- column. Row existence IS the "held" state, and deletion IS the "resolved"
-- state. Every terminal outcome — verified/unverified/24h timeout — deletes
-- the row. Adding a status column would double-track a state already carried
-- by row lifecycle and introduce a "resolved but not deleted" failure mode.
--
-- reminder_sent_at (Researcher fold-in): NOT a status column. It is a one-way
-- idempotency marker for the T+2h "still verifying, no action needed" email
-- (Task 3's `sweepReminders`) that fires WHILE the row is still open. A row
-- can be `reminder_sent_at IS NOT NULL` AND still open. Deletion still means
-- resolved. Nullable rather than DEFAULT — the marker is genuinely absent on
-- a fresh row.
--
-- UNIQUE(session_id) is the load-bearing idempotency key: Stripe redelivers
-- `checkout.session.completed` on 5xx, and Task 2's held branch UPSERTs on
-- this column so a replay is a no-op instead of a second refund path opening.
--
-- Additive-only, brand-new empty table: no CONCURRENTLY / backfill needed
-- per packages/db/MIGRATIONS.md.

CREATE TABLE IF NOT EXISTS "awaiting_vies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL UNIQUE,
	"customer_id" text NOT NULL,
	"kind" text NOT NULL,
	"payment_intent_id" text,
	"subscription_id" text,
	"currency" text NOT NULL,
	"amount_total" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"workspace_id" uuid NOT NULL
);

ALTER TABLE "awaiting_vies"
	DROP CONSTRAINT IF EXISTS "awaiting_vies_workspace_id_workspaces_id_fk";
ALTER TABLE "awaiting_vies"
	ADD CONSTRAINT "awaiting_vies_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE no action ON UPDATE no action;

ALTER TABLE "awaiting_vies"
	DROP CONSTRAINT IF EXISTS "awaiting_vies_kind_check";
ALTER TABLE "awaiting_vies"
	ADD CONSTRAINT "awaiting_vies_kind_check"
	CHECK ("kind" IN ('topup', 'subscription'));

CREATE INDEX IF NOT EXISTS "awaiting_vies_customer_idx"
	ON "awaiting_vies" ("customer_id");

CREATE INDEX IF NOT EXISTS "awaiting_vies_created_at_idx"
	ON "awaiting_vies" ("created_at");
