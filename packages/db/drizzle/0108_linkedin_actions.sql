-- LinkedIn action log: one append-only row per LinkedIn MCP tool call. Backs the daily caps,
-- the per-person rules and the outreach measurement. No content columns by design.
-- Down: drizzle/down/0108_linkedin_actions_down.sql.
--
-- Not a hot-table migration: the table is new and empty, so plain CREATE INDEX is safe here
-- (packages/db/MIGRATIONS.md Rule 1 only concerns indexes on existing hot tables).

CREATE TABLE IF NOT EXISTS "linkedin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"kind" text NOT NULL,
	"target_provider_id" text,
	"ref_id" text,
	"object_id" uuid,
	"approval_id" text,
	"outcome" text NOT NULL,
	"error_code" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_actions_integration_tool_created_idx" ON "linkedin_actions" USING btree ("integration_id","tool","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_actions_workspace_target_created_idx" ON "linkedin_actions" USING btree ("workspace_id","target_provider_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_actions_ok_ref_uniq" ON "linkedin_actions" USING btree ("integration_id","tool","ref_id") WHERE "outcome" = 'ok';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_actions_created_at_idx" ON "linkedin_actions" USING btree ("created_at");
