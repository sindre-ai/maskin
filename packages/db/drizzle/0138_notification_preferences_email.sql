-- Migration: summary email bookkeeping on notification_preferences
--   email_digest_enabled   the person's summary email choice. NULL means no choice yet, and it
--                          stays NULL on every row that exists today: four of the six rows were
--                          created by automatic defaults, so none of them is a real email choice.
--                          A saved true/false always wins over any default.
--   email_onboarding_step  0 = nothing sent yet, 1 to 3 = onboarding mails already sent.
--   email_last_sent_on     date of the last summary email (written by the sender, not here).
-- Additive columns on a small, non-hot table: plain statements are fine, no backfill, no flag.
-- Idempotent, safe to re-run. Down: drizzle/down/0138_notification_preferences_email_down.sql.

ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "email_digest_enabled" boolean;
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "email_onboarding_step" smallint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "email_last_sent_on" date;
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	DROP CONSTRAINT IF EXISTS "notification_preferences_email_step_chk";
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	ADD CONSTRAINT "notification_preferences_email_step_chk"
	CHECK ("email_onboarding_step" >= 0 AND "email_onboarding_step" <= 3);
