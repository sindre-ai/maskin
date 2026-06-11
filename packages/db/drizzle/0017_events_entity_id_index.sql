-- Index to support per-object event lookups used by GET /api/objects/:id/graph
-- (and the get_objects MCP tool which fans out to it). The existing
-- events_ws_created_at_idx covers workspace-wide feeds ordered by time, but
-- filtering by entity_id had no covering index — a workspace with many events
-- would fall back to scanning all of its events per object. The trailing id
-- column lets Postgres walk the index backwards to satisfy ORDER BY id DESC.
CREATE INDEX IF NOT EXISTS "events_ws_entity_id_idx"
	ON "events" ("workspace_id", "entity_id", "id");
