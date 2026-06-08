-- Partial index backing the `/api/billing/usage` token aggregate in the
-- `plan !== 'byollm'` branch. The query filters
-- `(workspace_id, created_at >= period_start, config->>'llm_route' = 'maskin_plan')`
-- and the endpoint fires every 30s per open Settings tab + the near-cap banner,
-- so the unindexed JSONB extraction would scan the workspace's sessions every
-- read as session volume grows. The partial WHERE keeps the index narrow —
-- only paid-plan + trial sessions tagged `maskin_plan` carry an entry, so the
-- BYO short-circuit and non-billing sessions cost nothing on insert.
--
-- `sessions` isn't on MIGRATIONS.md's hot-tables list so a plain CREATE INDEX
-- is fine; mirrors the partial-index pattern already in 0018/0019.
CREATE INDEX IF NOT EXISTS "sessions_maskin_plan_period_idx"
	ON "sessions" ("workspace_id", "created_at")
	WHERE config->>'llm_route' = 'maskin_plan';
