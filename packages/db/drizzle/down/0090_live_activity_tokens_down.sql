-- Rollback for 0090_live_activity_tokens.sql. Drops the table (indexes and the
-- check constraint go with it). Live Activity tokens are lost; the app
-- re-registers them the next time it launches / starts an activity.
DROP TABLE IF EXISTS "live_activity_tokens";
