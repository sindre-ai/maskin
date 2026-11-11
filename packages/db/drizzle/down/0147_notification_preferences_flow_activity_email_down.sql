-- Rollback for 0147_notification_preferences_flow_activity_email.sql. Drops both columns, which
-- loses every saved Flow activity Email switch and the hourly claims (nobody would get Flow
-- activity email until they switch it on again). Roll back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "notification_preferences"
	DROP COLUMN IF EXISTS "email_categories",
	DROP COLUMN IF EXISTS "flow_email_sent";
