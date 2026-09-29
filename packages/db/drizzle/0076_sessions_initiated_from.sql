-- Migration: sessions.initiated_from_object_{id,type} columns.
-- Records the object a session was started for (bet, task, insight, or any
-- other first-class object). Read at session_failed emit time so the failure
-- event carries a link back to what the session was doing, and at every
-- terminal telemetry emit so the PostHog runtime_session_ended event carries
-- context_object_id / context_object_type for Criterion 3 of the parent bet.
--
-- Both columns are nullable; NULL means "no originating object known"
-- (direct API create, onboarding, notification response, cron trigger). The
-- FK uses ON DELETE SET NULL so a deleted object nulls the linkage rather
-- than blocking the session row.
--
-- The CONCURRENTLY partial index on initiated_from_object_id lives in the
-- next migration (0077) — packages/db/MIGRATIONS.md Rule 1 requires
-- CREATE INDEX CONCURRENTLY to be the only statement in its file.
--
-- Idempotent — safe to re-run.

ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "initiated_from_object_id" uuid
		REFERENCES "objects"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "initiated_from_object_type" text;
