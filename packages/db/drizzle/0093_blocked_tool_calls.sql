-- Audit row for every tool call the guard wrapper refuses on a custom
-- extension (default-deny per tool). Powers the "Attempted" chip on the Agent
-- access grid. See packages/db/src/schema.ts § Blocked tool calls.
--
-- New table, so this is the expand step: nothing reads or writes it yet, and a
-- code revert leaves an unused table behind. It is not on the hot tables list
-- in MIGRATIONS.md (writes come from a session's guard report, not from an
-- external webhook), so plain CREATE INDEX (no CONCURRENTLY) is correct on a
-- table that is empty at creation. Rows older than 30 days are dropped by
-- BlockedToolCallsCleaner.
CREATE TABLE IF NOT EXISTS "blocked_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"extension_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"session_id" uuid,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_tool_calls_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "blocked_tool_calls_extension_id_extensions_id_fk"
		FOREIGN KEY ("extension_id") REFERENCES "public"."extensions"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "blocked_tool_calls_agent_id_actors_id_fk"
		FOREIGN KEY ("agent_id") REFERENCES "public"."actors"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "blocked_tool_calls_session_id_sessions_id_fk"
		FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id")
		ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocked_tool_calls_ext_agent_idx"
	ON "blocked_tool_calls" USING btree ("extension_id", "agent_id", "blocked_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocked_tool_calls_ws_time_idx"
	ON "blocked_tool_calls" USING btree ("workspace_id", "blocked_at" DESC);
