-- One row per tool call the voice model made during a call, so a call that
-- misbehaved can be read back: which tool, what it was sent (redacted and
-- capped by the app), whether it worked, and the start of what the model heard.
--
-- New table, plain DDL: nothing reads or locks existing rows (see MIGRATIONS.md,
-- not a hot table, no backfill). Rows are swept after 30 days by the app.
CREATE TABLE IF NOT EXISTS "voice_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_session_id" uuid NOT NULL REFERENCES "voice_sessions"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"call_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"tool_name" text NOT NULL,
	"args_summary" jsonb,
	"success" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"output_chars" integer NOT NULL,
	"output_truncated" boolean DEFAULT false NOT NULL,
	"latency_ms" integer NOT NULL,
	"output_preview" text
);
--> statement-breakpoint
ALTER TABLE "voice_tool_calls" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_tool_calls_session_started_idx" ON "voice_tool_calls" ("voice_session_id", "started_at");
--> statement-breakpoint
-- The retention sweep deletes by age.
CREATE INDEX IF NOT EXISTS "voice_tool_calls_started_at_idx" ON "voice_tool_calls" ("started_at");
