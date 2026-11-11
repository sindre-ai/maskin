-- Rollback for 0139_notification_preferences_browser.sql. Drops the column, which loses every
-- saved Browser switch (those kinds fall back to following their push switch). Roll back the code
-- that reads it first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "browser_categories";
