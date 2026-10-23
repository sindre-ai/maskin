-- Migration: a comment copied into an object's chat lands once, however often the copy runs.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other
-- statements (see packages/db/MIGRATIONS.md).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "messages_comment_event_uniq"
  ON "messages" ("conversation_id", (("metadata"->>'comment_event_id')))
  WHERE ("metadata"->>'comment_event_id') IS NOT NULL;
