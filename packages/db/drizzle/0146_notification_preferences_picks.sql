-- Migration: opt-in Marketplace pick in the summary email, on notification_preferences
--   marketplace_picks_enabled     the "Marketplace picks" switch. false on every row, so nobody gets a
--                                 pick until they switch it on.
--   marketplace_dismissed_loop_ids  Marketplace flows the person marked "Not useful"; never suggested
--                                 to them again. No new table.
--   marketplace_pick_last_sent_on date of the last mail that carried a pick (at most one a week).
-- Additive columns on a small, non-hot table: plain statements are fine, no backfill, no flag.
-- Idempotent, safe to re-run. Down: drizzle/down/0146_notification_preferences_picks_down.sql.

ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "marketplace_picks_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "marketplace_dismissed_loop_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_preferences"
	ADD COLUMN IF NOT EXISTS "marketplace_pick_last_sent_on" date;
