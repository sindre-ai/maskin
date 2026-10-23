-- Rollback for 0104_notification_preferences.sql. Drops the table; every actor
-- falls back to default push behaviour (nothing is muted, no quiet hours).
DROP TABLE IF EXISTS "notification_preferences";
