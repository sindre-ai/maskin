-- Allow multiple GitHub App installations per workspace. The previous
-- UNIQUE(workspace_id, provider) constraint forced a workspace to hold at
-- most one row per provider, so reconnecting a GitHub App against a second
-- org swapped the only stored installation. Widen the key to include
-- external_id (the GitHub installation_id) so N installs of the same
-- provider can coexist per workspace.
--
-- Pure DDL — no row data is read or written, so existing integrations rows
-- and their external_id values are untouched.
--
-- We need two partial unique indexes instead of a single triplet constraint:
-- - provider rows with external_id IS NULL must remain one-per-workspace
-- - GitHub installations with external_id IS NOT NULL can coexist per org
DROP INDEX IF EXISTS "integrations_ws_provider_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_ws_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "provider")
	WHERE "external_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_ws_provider_external_uniq"
	ON "integrations" ("workspace_id", "provider", "external_id")
	WHERE "external_id" IS NOT NULL;
