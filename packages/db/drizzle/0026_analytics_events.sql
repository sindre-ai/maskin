-- First-party UI analytics events emitted by apps/web's trackEvent helper.
-- Distinct from mcp_telemetry (purpose-shaped for MCP tool_call/mutation aggregates).
-- Keeping this table narrow makes bet KPI queries like
-- "≥1 menu_opened per active user per workday" a one-liner against (ws, actor, name, day).
CREATE TABLE IF NOT EXISTS "analytics_events" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"name" text NOT NULL,
	"props" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "analytics_events_ws_name_created_at_idx"
	ON "analytics_events" ("workspace_id", "name", "created_at");

CREATE INDEX IF NOT EXISTS "analytics_events_ws_actor_name_created_at_idx"
	ON "analytics_events" ("workspace_id", "actor_id", "name", "created_at");
