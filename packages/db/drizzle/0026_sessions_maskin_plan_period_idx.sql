-- Partial expression index supporting GET /api/billing/usage's plan-period
-- aggregate. The route runs
--   SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0))
--   WHERE workspace_id = $1 AND created_at >= $2
--     AND config->>'llm_route' = 'maskin_plan'
-- on every 30s refresh of the Settings → LLM row (and the near-cap banner
-- shares the same hook). Existing `sessions_ws_status_idx` is on
-- (workspace_id, status) and does not cover this access path; without an
-- index, the workspace predicate alone forces a scan + per-row JSONB
-- extraction as paid-plan session volume grows. The WHERE clause keeps the
-- index small by only covering maskin_plan sessions.
--
-- Plain `CREATE INDEX IF NOT EXISTS` (no CONCURRENTLY): `sessions` is not on
-- the hot-tables list in MIGRATIONS.md, so the standard pattern from
-- 0018/0019 sessions partial indexes applies.
CREATE INDEX IF NOT EXISTS "sessions_maskin_plan_period_idx"
	ON "sessions" ("workspace_id", "created_at")
	WHERE config->>'llm_route' = 'maskin_plan';
