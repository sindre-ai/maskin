-- Rollback for 0145_notification_preferences_picks.sql. Drops the three columns, which loses every
-- Marketplace picks switch and every "Not useful" dismissal (picks go back to off for everyone).
-- Roll back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "marketplace_pick_last_sent_on";
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "marketplace_dismissed_loop_ids";
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "marketplace_picks_enabled";
