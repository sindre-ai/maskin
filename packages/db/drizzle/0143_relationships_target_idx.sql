-- Edges are looked up by their TARGET: GET /api/objects/:id/graph and the relationships list
-- filter `target_id = $1` (or `target_id IN (...)`), and the spawned-session lookup asks for
-- `type = 'spawned' AND target_id IN (...)`. The only index on relationships is the unique
-- (source_id, target_id, type), which leads with source_id and so cannot serve any of them; every
-- such read scanned the whole table.
--
-- (target_id, type) rather than (target_id) alone: it serves the plain `target_id = $1` reads
-- through its leading column, and also the `type = 'spawned' AND target_id IN (...)` lookup
-- without fetching and discarding the other edge types. The extra column costs a few bytes per
-- entry on a narrow table.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). If an interrupted build leaves an INVALID index, drop it
-- first. Down: drizzle/down/0143_relationships_target_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "relationships_target_type_idx"
  ON "relationships" USING btree ("target_id", "type");
