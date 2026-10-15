-- Rollback for 0093_live_activity_pending_ends.sql. Card bookkeeping is lost; the app's own
-- sweep still clears stale cards the next time it runs.
DROP TABLE IF EXISTS "live_activity_cards";
