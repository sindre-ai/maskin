-- Partial index serving the For You unread feed (routes/subscriptions.ts).
--
-- The feed joins `events` to `subscriptions` on (workspace_id, entity_id) and
-- keeps only `action = 'commented'` rows past the actor's read cursor. The
-- existing events_ws_entity_id_idx covers every action, so on a busy entity
-- (a session, a bet with a long history) the join walked all of its events and
-- filtered at the heap — ~100k calls, mean 132ms, max 112s, and the events
-- table sitting at an 87% cache hit ratio. Restricting the index to comments
-- makes the probe touch only the rows that can count.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_ws_entity_commented_idx"
	ON "events" ("workspace_id", "entity_id", "id")
	WHERE "action" = 'commented';
