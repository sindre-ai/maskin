-- The agent page's Objects tab asks "which objects did this actor change?" (the third of three
-- reads behind GET /api/actors/:id/objects; created and drives read the object row).
--
-- events had no index on actor_id, so that question meant reading the workspace's whole event
-- history. This partial index holds only 'updated' and 'status_changed' events, keyed by actor,
-- so the lookup is a short range scan and the index stays a small slice of the table. It does not
-- filter on entity_type: object events are logged under the object's own type (task, bet, ...),
-- and the query keeps only ids that are real objects.
--
-- Write cost: only an 'updated' or 'status_changed' event adds an index entry. Every other event
-- (sessions, comments, creates, messages) is untouched.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted
-- build; drop an INVALID leftover first.
-- Down: drizzle/down/0139_events_actor_changed_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_actor_changed_idx"
  ON "events" USING btree ("actor_id", "entity_id")
  WHERE "action" IN ('updated', 'status_changed');
