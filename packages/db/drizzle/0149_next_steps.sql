-- The next step on a driven object: what happens next, who does it and by when.
--
-- Until now a plan was prose on the object, so only an agent that read it could tell a step was
-- late. One row per step, keyed to the driven object. At most one open or blocked step per object
-- (partial unique index), so "the next step" is a single answer. Closed rows (done, skipped) stay
-- as history, which gives the time from due to next action straight from the database.
--
-- A blocked step names exactly one thing it waits on: an object, an actor (with the question in
-- blocked_reason) or a decision card (the comment event id). Prose-only blocked is refused by the
-- check below. The three blocked_on_* foreign keys cascade: if the thing waited on is deleted the
-- step goes with it, the object is left with no step, and the missing-step check picks that up.
-- owner_actor_id, created_by, session_id and wake_trigger_id are SET NULL so history survives.
--
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is
-- fine and there is nothing to backfill. Old objects get no step. Row-level security is switched
-- on because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0149_next_steps_down.sql.

CREATE TABLE IF NOT EXISTS "next_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"object_id" uuid NOT NULL REFERENCES "objects"("id") ON DELETE CASCADE,
	"action" text NOT NULL,
	"owner_actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL DEFAULT 'open',
	"blocked_on_object_id" uuid REFERENCES "objects"("id") ON DELETE CASCADE,
	"blocked_on_actor_id" uuid REFERENCES "actors"("id") ON DELETE CASCADE,
	"blocked_on_decision_comment_id" bigint REFERENCES "events"("id") ON DELETE CASCADE,
	"blocked_reason" text,
	"evidence" text,
	"wake_trigger_id" uuid REFERENCES "triggers"("id") ON DELETE SET NULL,
	"wake_count" integer NOT NULL DEFAULT 0,
	"last_woken_at" timestamp with time zone,
	"created_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	"closed_at" timestamp with time zone,
	CONSTRAINT "next_steps_status_check" CHECK ("status" IN ('open', 'blocked', 'done', 'skipped')),
	CONSTRAINT "next_steps_blocked_on_check" CHECK (
		CASE WHEN "status" = 'blocked'
			THEN num_nonnulls("blocked_on_object_id", "blocked_on_actor_id", "blocked_on_decision_comment_id") = 1
			ELSE num_nonnulls("blocked_on_object_id", "blocked_on_actor_id", "blocked_on_decision_comment_id") = 0
		END
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "next_steps_one_live_per_object_idx"
	ON "next_steps" USING btree ("object_id")
	WHERE "status" IN ('open', 'blocked');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "next_steps_open_due_idx"
	ON "next_steps" USING btree ("due_at")
	WHERE "status" = 'open';
--> statement-breakpoint
ALTER TABLE "next_steps" ENABLE ROW LEVEL SECURITY;
