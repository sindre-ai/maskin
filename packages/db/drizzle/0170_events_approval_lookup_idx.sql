-- latestEvent in apps/dev/src/lib/object-delivery.ts looks up the newest 'approved', 'delivered' or
-- 'auto_sent' event of one object, up to three times per draft card on the For You feed:
--   FROM events JOIN actors ON actors.id = events.actor_id
--   WHERE workspace_id = $1 AND entity_id = $2 AND action = '<one of the three>'
--   ORDER BY events.id DESC LIMIT 1
-- Nothing indexed events by action for an object, so the planner walks events_ws_entity_id_idx and
-- filters every event of the object: about 15,000 pages and 116 ms warm (seconds cold) on an object
-- with 24,405 events, per lookup, and the cards run in parallel until the feed times out.
--
-- Partial, so it holds only those three actions (226 of 910,054 events today) and the write cost is
-- one more index entry on a rare event. The lookups spell the action as a literal, so the planner can
-- prove the query implies this predicate.
--
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted
-- build; drop an INVALID leftover first.
-- Down: drizzle/down/0170_events_approval_lookup_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_approval_lookup_idx"
  ON "events" USING btree ("workspace_id", "entity_id", "id")
  WHERE "action" IN ('approved', 'delivered', 'auto_sent');
