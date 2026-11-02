-- One row per deep_research run: question, cap and metered cost, report.
-- cost_cents feeds getWorkspacePlanUsdCentsUsage so a run counts against the plan cap.
--
-- New table, plain DDL: nothing reads or locks existing rows (see MIGRATIONS.md,
-- not a hot table, no backfill). The index is created with the table, which is empty.
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
	"searches" integer DEFAULT 0 NOT NULL,
	"extracts" integer DEFAULT 0 NOT NULL,
	"llm_route" text,
	"model" text,
	"brief" jsonb,
	"findings" jsonb,
	"report_md" text,
	"sources" jsonb,
	"warnings" jsonb,
	"stages" jsonb,
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
