-- Migration: how often the summary email comes, on notification_preferences
--   email_rhythm   'daily' or 'weekly'. NULL (every row that exists today) means daily, so nobody
--                  is moved to weekly by this migration. Off is email_digest_enabled = false, not
--                  a value here.
-- Additive nullable column on a small, non-hot table: plain statements are fine, no backfill, no flag.
-- Idempotent, safe to re-run. Down: drizzle/down/0145_notification_preferences_email_rhythm_down.sql.

ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "email_rhythm" text;
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	DROP CONSTRAINT IF EXISTS "notification_preferences_email_rhythm_chk";
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	ADD CONSTRAINT "notification_preferences_email_rhythm_chk"
	CHECK ("email_rhythm" IS NULL OR "email_rhythm" IN ('daily', 'weekly'));
