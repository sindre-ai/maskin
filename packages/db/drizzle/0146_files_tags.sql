-- Free-form tags on a file (b-roll, clip_type:b_roll, ...), so people and agents can find files
-- by tag. Trimmed and lowercased by the API on write; the column itself holds whatever it is given.
--
-- Expand step: a constant default ('{}') on a new column is a catalog-only change in Postgres 11+,
-- so no table rewrite and no long lock. Every existing row reads as an empty list, and the previous
-- code, which never mentions the column, keeps working. `files` is not on the hot-table list in
-- MIGRATIONS.md. file_uploads carries the tags of an in-flight large upload until it completes.
-- The GIN index that serves the tag filters is in 0147, alone in its file because it is built
-- CONCURRENTLY.
-- Down: drizzle/down/0146_files_tags_down.sql.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "file_uploads" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}'::text[] NOT NULL;
