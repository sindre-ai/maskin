-- Catalog table for standalone skill archetypes (Marketplace Skills tab).
-- workspace_id NULL = global Maskin-curated row. See Marketplace tech spec §2.2.
CREATE TABLE IF NOT EXISTS "marketplace_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid REFERENCES "workspaces"("id"),
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"outcome_line" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"team" text NOT NULL,
	"recommendation" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"requires" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"status" text NOT NULL DEFAULT 'published',
	"sort_weight" integer NOT NULL DEFAULT 0,
	"install_count" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_skills_ws_slug_idx"
	ON "marketplace_skills" ("workspace_id", "slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_skills_team_status_idx"
	ON "marketplace_skills" ("team", "status");
