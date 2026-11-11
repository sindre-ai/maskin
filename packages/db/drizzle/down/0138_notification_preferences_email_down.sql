-- Rollback for 0138_notification_preferences_email.sql. Drops the three email columns, which
-- loses every saved email choice and the send bookkeeping. Roll back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_email_step_chk";
--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "email_last_sent_on";
--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "email_onboarding_step";
--> statement-breakpoint
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "email_digest_enabled";
