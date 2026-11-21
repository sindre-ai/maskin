-- countPendingTriggersFromSelfStartedRuns (apps/dev/src/services/self-start-limits.ts) counts the
-- triggers an agent made from self-started runs:
--   FROM events e JOIN triggers t ON t.id = e.entity_id
--   WHERE e.workspace_id = $1 AND e.entity_type = 'trigger' AND e.action = 'created'
--     AND e.actor_id = $2 AND e.data->>'created_from_start_reason' IS NOT NULL AND t.enabled
-- Nothing indexed events by actor for trigger events, so it read every event of the workspace:
-- 498 calls on production, 9.9 s on average, 72.9 s at worst.
--
-- Partial on exactly that predicate, so it holds only the trigger events a self-started run
-- wrote (a handful), and the write cost on `events` is one index entry on a rare event. The pool
-- runs with prepare: false, so the planner sees the real values and can prove the query implies
-- the predicate.
--
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). Down: drizzle/down/0171_events_self_start_trigger_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_self_start_trigger_idx"
  ON "events" USING btree ("workspace_id", "actor_id", "entity_id")
  WHERE "entity_type" = 'trigger' AND "action" = 'created'
    AND ("data" ->> 'created_from_start_reason') IS NOT NULL;
