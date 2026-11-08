-- Unread feed (GET /api/subscriptions/unread): find the comments that @-mention a person from an index.
--
-- The feed only counts comments that mention the reader (plus onboarding coach replies, which are read
-- another way). Without this index Postgres fetched every comment of every entity the reader follows and
-- tested the mention on each one (17k calls a week, 1.1 s average). This partial GIN index holds only the
-- comment events and answers "mentions this actor" directly.
--
-- Write cost: one extra index entry per comment event; other event actions are not in the index.
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted build;
-- drop an INVALID leftover first.
-- Down: drizzle/down/0136_events_comment_mentions_gin_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_comment_mentions_gin_idx"
  ON "events" USING gin ((("data" -> 'mentions')) jsonb_path_ops)
  WHERE "action" = 'commented';
