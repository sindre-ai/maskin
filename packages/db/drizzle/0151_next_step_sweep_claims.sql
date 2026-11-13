-- One row per object, reason and time bucket for the sweep that looks for overdue or missing next
-- steps (bet "Agents take the lead", task "Sweep for overdue next steps, wake drivers").
--
-- The sweep runs on every server instance. Inserting the row is the claim: the unique indexes let
-- exactly one instance act on an object for a reason in a bucket, so a step is never woken twice in
-- the hour and two instances never race. The same rows are the record of the record-only period:
-- mode 'recorded' means the sweep found the object and started nothing (one bucket per day).
-- 'woken' started a run, 'refused' means the cap, back-off or daily budget refused it (one bucket
-- per hour). Recorded and decided rows have an index each, so a day bucket and an hour bucket that
-- start at the same moment never block each other.
--
-- driver_actor_id has no foreign key on purpose: this is a log of what the sweep decided, and an
-- agent that is later removed must not take the record with it. Rows go with the workspace and with
-- the object (ON DELETE CASCADE).
--
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine
-- and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0151_next_step_sweep_claims_down.sql.

CREATE TABLE IF NOT EXISTS "next_step_sweep_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"object_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"driver_actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "next_step_sweep_claims_reason_check" CHECK ("reason" IN ('step_overdue', 'no_next_step')),
	CONSTRAINT "next_step_sweep_claims_mode_check" CHECK ("mode" IN ('recorded', 'woken', 'refused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "next_step_sweep_claims_recorded_idx"
	ON "next_step_sweep_claims" USING btree ("object_id", "reason", "bucket_start")
	WHERE "mode" = 'recorded';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "next_step_sweep_claims_decided_idx"
	ON "next_step_sweep_claims" USING btree ("object_id", "reason", "bucket_start")
	WHERE "mode" <> 'recorded';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "next_step_sweep_claims_workspace_created_idx"
	ON "next_step_sweep_claims" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
ALTER TABLE "next_step_sweep_claims" ENABLE ROW LEVEL SECURITY;
