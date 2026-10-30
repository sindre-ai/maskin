-- Custom (bring-your-own) extensions: one workspace-scoped row per user-added
-- integration, carrying an optional MCP config, an optional webhook config, and
-- the per-agent tool grants. See packages/db/src/schema.ts § Extensions.
--
-- New table, so this is the expand step: nothing reads or writes it yet, and a
-- code revert leaves an unused table behind. blocked_tool_calls is NOT created
-- here; the guard wrapper task owns it. `extensions` is not on the hot tables
-- list in MIGRATIONS.md, so plain CREATE INDEX (no CONCURRENTLY) is correct.
CREATE TABLE IF NOT EXISTS "extensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"mcp_config" jsonb,
	"webhook_config" jsonb,
	"webhook_token" text,
	"tool_grants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mcp_last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extensions_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "extensions_created_by_actors_id_fk"
		FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id")
		ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "extensions_workspace_slug_uniq"
	ON "extensions" USING btree ("workspace_id", "slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "extensions_webhook_token_uniq"
	ON "extensions" USING btree ("webhook_token")
	WHERE "webhook_token" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extensions_workspace_status_idx"
	ON "extensions" USING btree ("workspace_id", "status");
