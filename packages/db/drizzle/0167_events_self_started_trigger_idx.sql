-- "How many triggers did this agent make from self-started runs that are still enabled?" is asked on
-- every trigger creation by a self-started agent, by countPendingTriggersFromSelfStartedRuns in
-- apps/dev/src/services/self-start-limits.ts:
--   FROM events e JOIN triggers t ON t.id = e.entity_id
--   WHERE e.workspace_id = $1 AND e.entity_type = 'trigger' AND e.action = 'created'
--     AND e.actor_id = $2 AND e.data->>'created_from_start_reason' IS NOT NULL AND t.enabled = true
-- Nothing indexed the trigger-created events by agent, so it does a nested loop over about 2,260
-- enabled triggers with an index probe into events for each: 6 to 15 seconds and about 109,000
-- buffers per call, which holds database connections and starves the pool.
--
-- Partial, so it holds only the trigger-created events that carry a start reason (about 242 rows),
-- a tiny slice of the table, and no other event is touched. The query's own WHERE implies the index
-- predicate, so the planner can use it and the call should drop to milliseconds.
--
-- Write cost: one more index entry, but only on the rare trigger-created event with a start reason.
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted
-- build; drop an INVALID leftover first.
-- Down: drizzle/down/0167_events_self_started_trigger_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_self_started_trigger_idx"
  ON "events" USING btree ("workspace_id", "actor_id", "entity_id")
  WHERE "entity_type" = 'trigger' AND "action" = 'created' AND ("data" ->> 'created_from_start_reason') IS NOT NULL;
