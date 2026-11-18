-- Rollback for 0167_youtube_pending_actions.sql. Drops every waiting action and the whole decision
-- audit, which cannot be rebuilt. Roll back the code that reads them first, and keep a copy of
-- youtube_action_audit if the "no public action without approval" record must survive.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "youtube_action_audit";
DROP TABLE IF EXISTS "youtube_pending_actions";
