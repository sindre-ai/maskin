-- Migration: make the "does this session already have its completion event?" probe cheap.
--
-- The session self-heal job (apps/dev/src/services/session-reconciler.ts) asks, per terminal
-- session, whether an `events` row exists for (entity_type = 'session', entity_id, action). The
-- only index that led with entity_id was events_ws_entity_id_idx, which fetches every event of
-- the session from the heap and filters entity_type/action there. This partial index answers the
-- question from the index alone.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other
-- statements (see packages/db/MIGRATIONS.md). `events` is written on every mutation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_session_entity_action_idx"
  ON "events" USING btree ("entity_id", "action", "workspace_id")
  WHERE "entity_type" = 'session';
