-- Rollback for 0136_events_comment_mentions_gin_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The unread feed keeps working without it: it falls back to testing the mention on every comment of
-- each followed entity, correct but slower.
DROP INDEX CONCURRENTLY IF EXISTS "events_comment_mentions_gin_idx";
