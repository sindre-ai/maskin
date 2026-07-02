-- Migration: managed catalog tables for the loops marketplace.
--   catalog_packages       — published, semver-versioned bundles.
--   catalog_package_items  — frozen actor/trigger/skill/integration snapshots
--                            per published package (item_snapshot is JSONB).
--   installed_packages     — per-workspace install rows with lock + fork lineage.
--
-- Re-provisioning convention (no extra column on element tables): every
-- actor/trigger/skill/integration row created by an install carries
--   metadata.installed_package_id  -> installed_packages.id
--   metadata.source_item_id        -> catalog_package_items.source_item_id
-- so the T5 version-push cron can find installed rows and resolve intra-package
-- wiring against the snapshot graph rather than the live publisher workspace.
-- The convention is also documented on the Drizzle schema definitions.
--
-- None of these tables are hot (only webhook_deliveries is), so plain
-- CREATE INDEX is fine — no CONCURRENTLY required. Migration is irreversible:
-- Sebastian acknowledged the three new tables in the architecture review.

CREATE TABLE IF NOT EXISTS "catalog_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text NOT NULL,
	"version" text NOT NULL,
	"use_case" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_packages_slug_unique" UNIQUE ("slug")
);

CREATE TABLE IF NOT EXISTS "catalog_package_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"source_item_id" uuid NOT NULL,
	"item_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_package_items_item_type_check"
		CHECK ("item_type" IN ('actor', 'trigger', 'skill', 'integration'))
);

ALTER TABLE "catalog_package_items"
	DROP CONSTRAINT IF EXISTS "catalog_package_items_package_id_catalog_packages_id_fk";
ALTER TABLE "catalog_package_items"
	ADD CONSTRAINT "catalog_package_items_package_id_catalog_packages_id_fk"
	FOREIGN KEY ("package_id") REFERENCES "public"."catalog_packages"("id")
	ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "catalog_package_items_package_idx"
	ON "catalog_package_items" USING btree ("package_id");
CREATE INDEX IF NOT EXISTS "catalog_package_items_package_source_idx"
	ON "catalog_package_items" USING btree ("package_id", "source_item_id");

CREATE TABLE IF NOT EXISTS "installed_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_package_id" uuid NOT NULL,
	"installed_version" text NOT NULL,
	"is_locked" boolean DEFAULT true NOT NULL,
	"forked_at" timestamp with time zone,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installed_packages_ws_source_uniq"
		UNIQUE ("workspace_id", "source_package_id")
);

ALTER TABLE "installed_packages"
	DROP CONSTRAINT IF EXISTS "installed_packages_workspace_id_workspaces_id_fk";
ALTER TABLE "installed_packages"
	ADD CONSTRAINT "installed_packages_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "installed_packages"
	DROP CONSTRAINT IF EXISTS "installed_packages_source_package_id_catalog_packages_id_fk";
ALTER TABLE "installed_packages"
	ADD CONSTRAINT "installed_packages_source_package_id_catalog_packages_id_fk"
	FOREIGN KEY ("source_package_id") REFERENCES "public"."catalog_packages"("id")
	ON DELETE no action ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "installed_packages_source_locked_idx"
	ON "installed_packages" USING btree ("source_package_id", "is_locked");
