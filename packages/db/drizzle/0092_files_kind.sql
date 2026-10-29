-- What a file is for, beyond its mime type. 'briefing' marks an HTML page written to
-- be read in For you; only those are shown there, so a loop's incidental output
-- files stay out of the row.
--
-- Nullable with no default, so this is a metadata-only ALTER (expand step): every
-- reader and writer of the previous code is unaffected, and NULL means "an ordinary
-- file". `files` is not on the hot-table list in MIGRATIONS.md, so a plain index
-- build is fine; it is its own statement after the ALTER.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_ws_kind_created_at_idx"
	ON "files" USING btree ("workspace_id", "kind", "created_at");
