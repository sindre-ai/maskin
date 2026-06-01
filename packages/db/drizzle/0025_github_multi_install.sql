-- Allow multiple GitHub App installations per workspace. The previous
-- UNIQUE(workspace_id, provider) constraint forced a workspace to hold at
-- most one row per provider, so reconnecting a GitHub App against a second
-- org swapped the only stored installation. Widen the key to include
-- external_id (the GitHub installation_id) so N installs of the same
-- provider can coexist per workspace.
--
-- Pure DDL — no row data is read or written, so existing integrations rows
-- and their external_id values are untouched. The new constraint is strictly
-- looser than the old one (every (workspace_id, provider) pair that was
-- unique before is still unique under the triplet), so this cannot reject
-- any existing row at apply time.
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_ws_provider_uniq";
--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_ws_provider_external_uniq" UNIQUE ("workspace_id", "provider", "external_id");
