-- "Which comments mention this actor?" is asked by GET /api/subscriptions/unread and by the For
-- You decision cards, and nothing indexed it. The only index that fits, events_ws_entity_commented_idx,
-- is keyed by (workspace_id, entity_id, id); neither query names an entity, so each read every
-- comment in the workspace (4,800 to 43,000 rows) and discarded nearly all of them: 144 ms for the
-- decision cards and 500 ms for the unread list on production data, against 3 ms and 41 ms with
-- this index.
--
-- A GIN index over the mentions array, partial to comment rows, so it holds a small slice of the
-- table and only a new comment adds an entry. The expression matches the one the queries write
-- (data -> 'mentions' @> ...), which is what lets the planner use it.
--
-- Already built by hand on production under this name while it was being measured; IF NOT EXISTS
-- makes this a no-op there, and builds it everywhere else. Alone in its file: CREATE INDEX
-- CONCURRENTLY cannot share a transaction with other statements (see packages/db/MIGRATIONS.md
-- Rule 1). If an interrupted build leaves an INVALID index, drop it first.
-- Down: drizzle/down/0142_events_commented_mentions_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_commented_mentions_idx"
  ON "events" USING gin ((data -> 'mentions'))
  WHERE "action" = 'commented';
