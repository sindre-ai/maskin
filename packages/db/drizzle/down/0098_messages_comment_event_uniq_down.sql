-- Rollback for 0098_messages_comment_event_uniq.sql.
DROP INDEX CONCURRENTLY IF EXISTS "messages_comment_event_uniq";
