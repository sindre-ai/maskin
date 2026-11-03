-- File comments: threaded review pins on a file's rendered document, batched
-- into "rounds" that write one rollup event on the attaching object. Replaces
-- the viewport-fraction files.annotations blob. See
-- packages/db/src/schema.ts § File Comments and routes/file-comments.ts for
-- the endpoint set + attaching-object validation matrix.
--
-- `files` is not on the hot tables list in MIGRATIONS.md — plain CREATE INDEX
-- (no CONCURRENTLY) is correct here; new table, no live writes racing us.
CREATE TABLE IF NOT EXISTS "file_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"page" integer,
	-- { x, y } floats in [0,1] of the natural document dimensions — NOT viewport
	-- fractions. Legacy rows ported from files.annotations preserve the pre-
	-- refactor viewport-fraction values verbatim (drift accepted per spec).
	"position_doc" jsonb NOT NULL,
	-- 'legacy' is reserved as the marker for rows ported from files.annotations
	-- so the one-shot re-hydration on first read stays idempotent without a
	-- second column.
	"selector" text,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"parent_id" uuid,
	-- Null while draft. Set to a client-generated uuid on Send; the round
	-- endpoint upserts on this key so a retried Send is a no-op.
	"round_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_comments_file_id_files_id_fk"
		FOREIGN KEY ("file_id") REFERENCES "public"."files"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "file_comments_author_id_actors_id_fk"
		FOREIGN KEY ("author_id") REFERENCES "public"."actors"("id")
		ON DELETE no action ON UPDATE no action,
	CONSTRAINT "file_comments_parent_id_file_comments_id_fk"
		FOREIGN KEY ("parent_id") REFERENCES "public"."file_comments"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "file_comments_resolved_by_actors_id_fk"
		FOREIGN KEY ("resolved_by") REFERENCES "public"."actors"("id")
		ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_comments_file_page_created_at_idx"
	ON "file_comments" ("file_id", "page", "created_at");
--> statement-breakpoint
-- Partial index — every unsent draft has round_id IS NULL, so the panel's
-- round-scoped filter is the only reader of the populated rows.
CREATE INDEX IF NOT EXISTS "file_comments_round_id_idx"
	ON "file_comments" ("round_id") WHERE "round_id" IS NOT NULL;
--> statement-breakpoint
-- updatedAt maintenance. Postgres has no ON UPDATE trigger built-in; a
-- BEFORE-UPDATE row trigger bumps the column on every real mutation so
-- panel refreshes see the latest resolve/reopen without the route having to
-- pass the new timestamp explicitly.
CREATE OR REPLACE FUNCTION file_comments_touch_updated_at()
RETURNS trigger AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS file_comments_touch_updated_at ON "file_comments";
--> statement-breakpoint
CREATE TRIGGER file_comments_touch_updated_at
	BEFORE UPDATE ON "file_comments"
	FOR EACH ROW
	EXECUTE FUNCTION file_comments_touch_updated_at();
