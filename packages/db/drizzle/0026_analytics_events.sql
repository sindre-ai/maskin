-- First-party product analytics sink. The frontend `trackEvent` primitive
-- (apps/web/src/lib/analytics.ts) POSTs one row per event so bet KPIs can be
-- answered by a plain DB query (e.g. "≥1 menu_opened per active user per
-- workday averaged over the final two weeks"). Kept distinct from
-- mcp_telemetry, which is shaped for MCP tool_call/mutation aggregates.
CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"name" text NOT NULL,
	"props" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Bet KPI query: events bucketed by (workspace, name) over a date range.
CREATE INDEX IF NOT EXISTS "analytics_events_ws_name_created_at_idx"
	ON "analytics_events" ("workspace_id", "name", "created_at");

-- Per-actor-per-day query: distinct actors with ≥1 event of a given name per day.
CREATE INDEX IF NOT EXISTS "analytics_events_ws_actor_name_created_at_idx"
	ON "analytics_events" ("workspace_id", "actor_id", "name", "created_at");
