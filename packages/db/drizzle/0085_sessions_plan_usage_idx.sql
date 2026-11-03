-- Partial index for `getWorkspacePlanUsdCentsUsage` (lib/llm-routing.ts),
-- behind GET /api/billing/usage.
--
-- That read sums cost over a workspace's maskin_plan sessions since the period
-- start. It filters on workspace_id, created_at and `config->>'llm_route'`, but
-- no index covered the JSON predicate, so it visited every session row the
-- workspace has ever had (mean 1.6s at the edge for a 570-byte response).
-- This index holds only maskin_plan sessions, ordered by (workspace_id,
-- created_at), so the period scan reads just the rows it sums.
--
-- The query inlines the literal 'maskin_plan' rather than binding it, so the
-- match with this partial predicate holds even under a generic cached plan.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_ws_plan_usage_idx"
	ON "sessions" ("workspace_id", "created_at")
	WHERE ("config" ->> 'llm_route') = 'maskin_plan';
