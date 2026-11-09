-- Rollback for 0138_live_activity_follows.sql. Follow bookkeeping is lost; a card already on a
-- phone just stops receiving updates and goes stale after 15 minutes (ActivityKit stale date).
-- Roll back the code that reads live_activity_follows first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "live_activity_follows";
