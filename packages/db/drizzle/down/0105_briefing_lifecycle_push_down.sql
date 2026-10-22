-- Rollback for 0105_briefing_lifecycle_push.sql. Drops the bookkeeping columns; the schedulers
-- are then unable to run (they select these columns), so disable them first
-- (FEATURE_BRIEFING_PUSH=0, PUSH_LIFECYCLE_ENABLED unset) or roll the code back too.
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "lifecycle_sent";
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "briefing_last_sent_on";
