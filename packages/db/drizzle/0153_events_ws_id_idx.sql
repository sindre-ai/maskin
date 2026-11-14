-- Event stream reconnect replay (GET /api/events with Last-Event-ID): "this workspace's events after
-- id N, oldest first, 100 rows".
--
-- No index led with workspace_id and then id, so Postgres walked the primary key from the cursor and
-- discarded every row of other workspaces on the way: 538 ms for 100 rows on production, about 395k
-- rows thrown away, worse for a stale cursor. This index serves the filter and the order together.
--
-- Write cost: one more index entry on every event insert (all actions), small at the current rate.
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted build;
-- drop an INVALID leftover first.
-- Down: drizzle/down/0153_events_ws_id_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_ws_id_idx"
  ON "events" USING btree ("workspace_id", "id");
