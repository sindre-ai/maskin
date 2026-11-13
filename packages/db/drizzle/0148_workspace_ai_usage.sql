-- Migration: workspace_ai_usage — plan spend on Maskin's funded OpenRouter account that does not
-- belong to a session (today: the transcribe_file MCP tool). getWorkspacePlanUsdCentsUsage adds
-- the cost_usd of these rows to the session total, so the plan cap, the usage page and the prepaid
-- credit overage all count them. cost_usd is what OpenRouter reported for the request.
-- New table, not hot-listed: plain CREATE INDEX is fine. Rows cascade with the workspace; the actor
-- and the file are set null so deleting either never deletes the spend it caused. No triggers /
-- pg_notify. Idempotent — safe to re-run.
-- Down: drizzle/down/0148_workspace_ai_usage_down.sql.

CREATE TABLE IF NOT EXISTS "workspace_ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"audio_seconds" numeric(10, 2),
	"file_id" uuid REFERENCES "files"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_ai_usage_workspace_created_idx" ON "workspace_ai_usage" USING btree ("workspace_id", "created_at");
