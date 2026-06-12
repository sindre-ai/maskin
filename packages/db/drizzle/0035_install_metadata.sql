-- Migration: add `metadata jsonb` to the four element tables that managed-package
-- installs provision (actors, triggers, workspace_skills, integrations).
--
-- T1 (0034_catalog_packages.sql) defined the re-provisioning convention:
--   metadata.installed_package_id  -> installed_packages.id
--   metadata.source_item_id        -> catalog_package_items.source_item_id
-- but stopped short of giving these tables a column to carry the markers in.
-- Without the column, T3's install endpoint has nowhere to write them and
-- T5's version-push cron has no way to find installed rows to update / delete.
--
-- `metadata` is intentionally nullable — non-install rows leave it NULL,
-- install-provisioned rows fill it in. No default to keep existing rows
-- untouched and avoid the rewrite a default would imply.
--
-- None of these tables are hot per `webhook-deliveries-cleaner.ts` — only
-- `webhook_deliveries` is — so plain ADD COLUMN is fine, no CONCURRENTLY.
-- All ADDs are `IF NOT EXISTS` so the migration is safe to co-land with any
-- T3 PR that also reaches for the same column.

ALTER TABLE "actors"
	ADD COLUMN IF NOT EXISTS "metadata" jsonb;

ALTER TABLE "triggers"
	ADD COLUMN IF NOT EXISTS "metadata" jsonb;

ALTER TABLE "workspace_skills"
	ADD COLUMN IF NOT EXISTS "metadata" jsonb;

ALTER TABLE "integrations"
	ADD COLUMN IF NOT EXISTS "metadata" jsonb;

-- Lookup index keyed by `installed_package_id` so the T5 cron's
-- "all rows that belong to install X" join doesn't sequential-scan
-- the element tables every hour.
CREATE INDEX IF NOT EXISTS "actors_installed_package_idx"
	ON "actors" ((("metadata"->>'installed_package_id')))
	WHERE "metadata" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "triggers_installed_package_idx"
	ON "triggers" ((("metadata"->>'installed_package_id')))
	WHERE "metadata" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "workspace_skills_installed_package_idx"
	ON "workspace_skills" ((("metadata"->>'installed_package_id')))
	WHERE "metadata" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "integrations_installed_package_idx"
	ON "integrations" ((("metadata"->>'installed_package_id')))
	WHERE "metadata" IS NOT NULL;
