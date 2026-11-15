-- The done-when list for a job (bet "Agents take the lead", task "Write a done-when list before
-- work starts"). A job's "done" is written as a few lines a person approves before work starts, and
-- each line carries its own state, so progress is read from here and not from an agent's memory.
--
-- A table of its own, not object metadata: any writer of the object could edit metadata, and an
-- agent could approve its own list. Two states per line. draft: the agent writes and rewrites
-- these freely (only through a decision card it posts). approved: written only when a person
-- taps Approve on that card; an agent can never create or edit one. superseded: kept when a later
-- version replaces an approved one. At most one draft or approved list per object at a time is
-- kept by the application: it replaces the old draft rows in one transaction.
--
-- checked_by says who reads the line: code (a reading and comparison the system can check),
-- checker (a second agent) or person. reading and comparison are only filled for a code line.
-- state is true, false, cannot_tell or not_checked; until the outcome check lands only a person
-- ticks a line (state_set_by is a person then).
--
-- done_when_skips records "list skipped, because X" so the skip rate can be counted. A skip the
-- server refused is recorded as an event, not here.
--
-- New, empty tables, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine
-- and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before these tables existed.
-- Down: drizzle/down/0159_done_when_lines_down.sql.

CREATE TABLE IF NOT EXISTS "done_when_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"object_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"version" integer NOT NULL DEFAULT 1,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"checked_by" text NOT NULL,
	"needs_yes" boolean NOT NULL DEFAULT false,
	"reading" text,
	"comparison" text,
	"list_status" text NOT NULL DEFAULT 'draft',
	"state" text NOT NULL DEFAULT 'not_checked',
	"state_set_at" timestamp with time zone,
	"state_set_by" uuid,
	"approved_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"approved_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "done_when_lines_checked_by_check" CHECK ("checked_by" IN ('code', 'checker', 'person')),
	CONSTRAINT "done_when_lines_list_status_check" CHECK ("list_status" IN ('draft', 'approved', 'superseded')),
	CONSTRAINT "done_when_lines_state_check" CHECK ("state" IN ('true', 'false', 'cannot_tell', 'not_checked'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "done_when_lines_object_idx"
	ON "done_when_lines" USING btree ("object_id", "list_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "done_when_lines_workspace_idx"
	ON "done_when_lines" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "done_when_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "done_when_skips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"object_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"reason" text NOT NULL,
	"skipped_by" uuid NOT NULL,
	"skipped_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "done_when_skips_one_per_object_idx"
	ON "done_when_skips" USING btree ("object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "done_when_skips_workspace_idx"
	ON "done_when_skips" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "done_when_skips" ENABLE ROW LEVEL SECURITY;
