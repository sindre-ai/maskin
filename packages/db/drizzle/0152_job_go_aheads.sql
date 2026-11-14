-- One person's go-ahead for one job (bet "Agents take the lead", task "Store the go-ahead on the
-- job"). When a person says "keep going without asking me for each step" about a job, that yes is
-- stored here instead of living in one chat message, so every later session on the job can see it.
--
-- A table of its own, not object metadata: any writer of the object could edit metadata, and an
-- agent could grant itself the yes. Rows are written only by the go-ahead route, which checks that
-- a person gave it (a person's own action, or a quoted chat message written by a person in a chat
-- about this job). A take-back sets taken_back_at; the row stays as the record. At most one live
-- row per object (partial unique index). The go-ahead ends when the job closes: that is read from
-- the object's status, so there is nothing to clean up.
--
-- granted_by has ON DELETE CASCADE: a go-ahead from a person who no longer exists is not a go-ahead.
-- message_id is the quoted chat message (ON DELETE SET NULL: the record outlives the message).
-- recorded_by is who called the route (the person, or the agent that quoted them); no foreign key,
-- it is a log. Same for taken_back_by.
--
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine
-- and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0152_job_go_aheads_down.sql.

CREATE TABLE IF NOT EXISTS "job_go_aheads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"object_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"granted_by" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"via" text NOT NULL,
	"message_id" bigint REFERENCES "messages"("id") ON DELETE SET NULL,
	"recorded_by" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL DEFAULT now(),
	"taken_back_at" timestamp with time zone,
	"taken_back_by" uuid,
	CONSTRAINT "job_go_aheads_via_check" CHECK ("via" IN ('chat', 'card'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "job_go_aheads_one_live_per_object_idx"
	ON "job_go_aheads" USING btree ("object_id")
	WHERE "taken_back_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_go_aheads_workspace_idx"
	ON "job_go_aheads" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "job_go_aheads" ENABLE ROW LEVEL SECURITY;
