-- Audit table for Marketplace installs. One row per workspace-scoped install
-- for any item_kind. The partial unique index on
-- (workspace_id, item_kind, catalog_slug) WHERE uninstalled_at IS NULL is
-- what makes POST /api/marketplace/install idempotent — a second install of
-- the same slug hits the conflict and the service returns 200 with the
-- existing row. Soft-delete via `uninstalled_at` preserves the audit trail
-- for install-count metrics. See Marketplace tech spec §2.2, §3.2, §3.3.
CREATE TABLE IF NOT EXISTS "marketplace_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"item_kind" text NOT NULL,
	"catalog_id" uuid NOT NULL,
	"catalog_slug" text NOT NULL,
	-- Reverse pointers into the workspace-scoped rows created at install.
	-- ON DELETE SET NULL because uninstall hard-deletes some of those rows
	-- (installed_loops on loop uninstall, workspace_skills when the fan-out
	-- check finds no other referrers) BEFORE the audit row is soft-deleted in
	-- the same transaction. A NO ACTION default would raise 23503 and abort
	-- the uninstall; SET NULL orphans the pointer, which is fine because the
	-- audit row's item_kind + catalog_slug are the load-bearing history keys.
	"installed_loop_id" uuid REFERENCES "installed_loops"("id") ON DELETE SET NULL,
	"actor_id" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"workspace_skill_id" uuid REFERENCES "workspace_skills"("id") ON DELETE SET NULL,
	"mcp_installation_id" uuid,
	"trigger_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"source" text NOT NULL,
	"installed_by_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"installed_at" timestamp with time zone NOT NULL DEFAULT now(),
	"uninstalled_at" timestamp with time zone,
	CONSTRAINT "marketplace_installations_item_kind_check"
		CHECK ("item_kind" IN ('loop', 'agent', 'skill', 'mcp_server')),
	CONSTRAINT "marketplace_installations_source_check"
		CHECK ("source" IN ('marketplace', 'seed', 'api'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "marketplace_installations_ws_kind_idx"
	ON "marketplace_installations" ("workspace_id", "item_kind");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "marketplace_installations_ws_kind_slug_live_idx"
	ON "marketplace_installations" ("workspace_id", "item_kind", "catalog_slug")
	WHERE "uninstalled_at" IS NULL;
