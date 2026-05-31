-- Drop the (workspace_id, name, created_at) index added in 0026.
-- The (workspace_id, actor_id, name, created_at) index covers the bet KPI
-- (count(DISTINCT actor_id) WHERE workspace_id = $1 AND name = $2 GROUP BY day)
-- via an index-only scan that already carries actor_id, so the 3-column index
-- only doubles per-write cost without adding query coverage.
-- CONCURRENTLY + IF EXISTS so this is safe to re-run and never blocks writes.
DROP INDEX CONCURRENTLY IF EXISTS "analytics_events_ws_name_created_at_idx";
