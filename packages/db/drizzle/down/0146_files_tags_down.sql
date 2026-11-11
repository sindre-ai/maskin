-- Rollback for 0146. Drops the tags: they are lost, the files and their bytes are untouched.
-- Run 0147's down first so the index is not dropped as a side effect of the column.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "file_uploads" DROP COLUMN IF EXISTS "tags";
--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN IF EXISTS "tags";
