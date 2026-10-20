-- Rollback for 0098_live_activity_cards.sql. Card bookkeeping is lost; the app's own
-- sweep still clears stale cards the next time it runs.
DROP TABLE IF EXISTS "live_activity_cards";
