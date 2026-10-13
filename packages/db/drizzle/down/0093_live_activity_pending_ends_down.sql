-- Rollback for 0093_live_activity_pending_ends.sql. Pending ends are lost; the on-device
-- sweep still clears the cards the next time the app runs.
DROP TABLE IF EXISTS "live_activity_pending_ends";
