-- Rollback for 0132. Recreates the empty research run table exactly as 0127 made it. Rows
-- dropped by 0132 are not restored (the table was empty when it was dropped).
--
-- Lives under drizzle/down/ so the forward runner never sees it.

CREATE TABLE IF NOT EXISTS "research_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"question" text NOT NULL,
	"context" text,
	"effort" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cap_cents" integer NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
	"llm_route" text,
	"model" text,
	"report_md" text,
	"sources" jsonb,
	"warnings" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "research_runs_status_check" CHECK ("status" IN ('queued', 'running', 'done', 'capped', 'failed', 'interrupted')),
	CONSTRAINT "research_runs_effort_check" CHECK ("effort" IN ('simple', 'comparison', 'broad'))
);
--> statement-breakpoint
ALTER TABLE "research_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_runs_workspace_created_idx" ON "research_runs" ("workspace_id", "created_at");
