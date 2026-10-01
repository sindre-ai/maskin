-- Migration: add skipped_count / updated_count to imports
-- An import whose mapping sets `matchOn` looks up existing objects of the same
-- type by that key. Matching rows are either skipped or used to update the
-- existing object (mapping.onMatch), and these columns record how many of each
-- so the import summary can report them alongside success_count.
-- `imports` is not on the hot-table list; ADD COLUMN with a constant default
-- is metadata-only on PG 11+.
-- Idempotent — safe to re-run.

ALTER TABLE "imports" ADD COLUMN IF NOT EXISTS "skipped_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN IF NOT EXISTS "updated_count" integer DEFAULT 0 NOT NULL;
