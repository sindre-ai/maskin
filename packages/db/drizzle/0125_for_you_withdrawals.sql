-- A withdrawn For You decision card: the agent that wrote it (or the Chief of Staff) retired it.
--
-- A decision card leaves a person's list when they answer it, dismiss it, the object closes or
-- the drafts are all handled. An agent that knows its own card is dead (a test card, a passed
-- deadline, a duplicate) had no way to retire it. One row per withdrawn source comment, global:
-- the card goes from every person's list, the briefing push and the lifecycle pushes, because
-- they all read the same loaders. Deleting the row is the undo; there is no route for it.
--
-- withdrawn_by is ON DELETE SET NULL on purpose: removing the withdrawer must not delete the row,
-- or the dead card would come back. The comment and workspace columns cascade, as in
-- for_you_dismissals (0122).
--
-- New, empty, low-volume table (one row per withdrawn card), not on the hot-tables list
-- (see MIGRATIONS.md), so plain DDL is fine and there is nothing to backfill. Row-level
-- security is switched on because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0125_for_you_withdrawals_down.sql.

CREATE TABLE IF NOT EXISTS "for_you_withdrawals" (
	"source_comment_id" bigint PRIMARY KEY REFERENCES "events"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"withdrawn_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "for_you_withdrawals" ENABLE ROW LEVEL SECURITY;
