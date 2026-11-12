-- Rollback for 0145_notification_preferences_email_rhythm.sql. Drops the column, which loses every
-- saved Weekly choice (those people go back to a daily summary). Roll back the code that reads it first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_email_rhythm_chk";
--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "email_rhythm";
