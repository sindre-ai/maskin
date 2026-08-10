-- Allow marketplace loops to ship extensions (modules) alongside agents,
-- triggers, skills and integrations.
--
-- Extensions are not rows in an element table — a workspace "has" an extension
-- when its id is present in `workspaces.settings.enabled_modules`. The install
-- path for an 'extension' item therefore merges the module's default settings
-- into the target workspace instead of inserting a row (see
-- applyExtensionSnapshot in apps/dev/src/services/loop-provisioning.ts).

ALTER TABLE marketplace_loop_items
	DROP CONSTRAINT IF EXISTS marketplace_loop_items_item_type_check;

ALTER TABLE marketplace_loop_items
	ADD CONSTRAINT marketplace_loop_items_item_type_check
	CHECK (item_type IN ('actor', 'trigger', 'skill', 'integration', 'extension'));
