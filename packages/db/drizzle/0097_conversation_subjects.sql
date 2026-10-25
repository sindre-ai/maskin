-- Migration: a group chat can be about one object or one installed loop.
--
-- Both columns are NULL for ordinary chats. One chat per subject per workspace.
-- Idempotent: IF NOT EXISTS / duplicate-safe so re-running is safe.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "subject_type" text;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "subject_id" uuid;

DO $$ BEGIN
  ALTER TABLE "conversations" ADD CONSTRAINT "conversations_subject_check" CHECK (
    ("subject_type" IS NULL AND "subject_id" IS NULL)
    OR ("subject_type" IN ('object', 'loop') AND "subject_id" IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_subject_uniq"
  ON "conversations" ("workspace_id", "subject_type", "subject_id")
  WHERE "subject_id" IS NOT NULL;
