-- The outcome check (bet "Agents take the lead", task "Check the outcome before driven work
-- closes"). When an agent asks to close a job that has an approved done-when list, the server marks
-- every line and stores the round here. Not object metadata, so no writer of the object can edit a
-- mark or an ending.
--
-- outcome_checks: one row per check round. marks is a list of {line_id, mark, by, reason}: mark is
-- yes, no or cannot_tell; by is code, checker or person. readings lists the stored readings a code
-- line was compared with. kind blind is a person's own mark of the same lines, made without seeing
-- the checker's (the blind sample), kept in the same table. ending is one of five and is set on a
-- round that closes the checking; a round that waits for a person has none. flags holds cheap
-- notes for a person to look at, never a reason to pass or fail.
--
-- job_outcomes: one row per job. ending is how checking ended. accepted_by / accepted_at are a
-- person's acceptance, a separate field the check never sets.
--
-- New, empty tables, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine
-- and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before these tables existed.
-- Down: drizzle/down/0160_outcome_checks_down.sql.

CREATE TABLE IF NOT EXISTS "outcome_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"object_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"kind" text NOT NULL DEFAULT 'round',
	"round" integer,
	"marks" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"readings" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"ending" text,
	"flags" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"requested_status" text,
	"checker_model" text,
	"session_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "outcome_checks_kind_check" CHECK ("kind" IN ('round', 'blind')),
	CONSTRAINT "outcome_checks_ending_check" CHECK ("ending" IS NULL OR "ending" IN ('checks_passed', 'sent_back', 'round_limit_reached', 'list_does_not_fit', 'stopped_by_person'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_checks_object_idx"
	ON "outcome_checks" USING btree ("object_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_checks_workspace_idx"
	ON "outcome_checks" USING btree ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outcome_checks_round_idx"
	ON "outcome_checks" USING btree ("object_id", "round")
	WHERE "kind" = 'round';
--> statement-breakpoint
ALTER TABLE "outcome_checks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_outcomes" (
	"object_id" uuid PRIMARY KEY REFERENCES "objects"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"ending" text,
	"ended_at" timestamp with time zone,
	"accepted_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"accepted_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "job_outcomes_ending_check" CHECK ("ending" IS NULL OR "ending" IN ('checks_passed', 'sent_back', 'round_limit_reached', 'list_does_not_fit', 'stopped_by_person'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_outcomes_workspace_idx"
	ON "job_outcomes" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "job_outcomes" ENABLE ROW LEVEL SECURITY;
