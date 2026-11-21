-- findViewerReplies (apps/dev/src/lib/for-you-visibility.ts) runs on every For You load:
--   FROM events WHERE workspace_id = $1 AND action = 'commented' AND actor_id = $2
--     AND entity_id IN (...) AND id >= $3 AND data->>'parentEventId' IS NOT NULL
-- The comments-only index is keyed by entity, so on an object with thousands of comments the
-- planner reads every comment of each listed object and filters by author. This is the likely
-- match for the "events looked up by many ids" line in the production statistics (335k calls,
-- 74 ms on average, 13.6 s at worst); not confirmed with EXPLAIN on production data.
--
-- Partial on threaded replies only, keyed by who wrote them and the event id, so the lookup is a
-- range over one person's replies since the oldest card, with the entity list as a filter.
--
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). Down: drizzle/down/0173_events_threaded_replies_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_threaded_replies_idx"
  ON "events" USING btree ("workspace_id", "actor_id", "id")
  WHERE "action" = 'commented' AND ("data" ->> 'parentEventId') IS NOT NULL;
