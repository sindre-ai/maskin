-- Rollback for 0142_events_commented_mentions_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- GET /api/subscriptions/unread and the For You decision cards still work without it, but go back
-- to reading every comment in the workspace to find the ones that mention the reader: slower on a
-- large workspace, never wrong.
DROP INDEX CONCURRENTLY IF EXISTS "events_commented_mentions_idx";
