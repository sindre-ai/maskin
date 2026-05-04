-- MCP telemetry table — records two event kinds emitted by packages/mcp/src/server.ts:
--   * tool_call    — every tool response (rich-render % numerator/denominator)
--   * mutation     — every successful update_objects / delete_object call
-- Aggregations live behind /api/telemetry/mcp/summary so workspace dashboards
-- (and the bet-evaluation document) can read the success metrics without
-- shaping queries themselves.
CREATE TABLE IF NOT EXISTS "mcp_telemetry" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"event_type" text NOT NULL,
	"tool_name" text NOT NULL,
	"session_id" text,
	"has_rich_render" boolean,
	"duration_ms" integer,
	"object_type" text,
	"mutation_kind" text,
	"data" jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "mcp_telemetry_ws_created_at_idx"
	ON "mcp_telemetry" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "mcp_telemetry_ws_event_type_idx"
	ON "mcp_telemetry" ("workspace_id", "event_type", "created_at");
