-- An explicit Dismiss for For You cards that is separate from the read position.
--
-- Opening an object page moves the read position, and the For You loaders used to treat
-- that as "done", so a card vanished the moment its page was opened. The loaders now stop
-- counting reads for cards that have a source comment. Dismiss needs its own record: one
-- row per person and source comment, unique on that pair. Curated cards keep using the
-- status on their notification row; this table is for decision cards, which have no row
-- of their own. Deleting the row is Undo.
--
-- New, empty, low-volume table (one row per tap on Dismiss), not on the hot-tables list
-- (see MIGRATIONS.md), so plain DDL is fine and there is nothing to backfill. Row-level
-- security is switched on because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0119_for_you_dismissals_down.sql.

CREATE TABLE IF NOT EXISTS "for_you_dismissals" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"source_comment_id" bigint NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "for_you_dismissals_pk" PRIMARY KEY ("actor_id", "source_comment_id")
);
--> statement-breakpoint
ALTER TABLE "for_you_dismissals" ENABLE ROW LEVEL SECURITY;
