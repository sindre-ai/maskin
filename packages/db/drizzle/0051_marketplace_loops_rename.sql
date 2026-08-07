-- Renames the marketplace "catalog" system to "marketplace", and its
-- installable "package" concept to "loop" — matching the product decision
-- to stop using "catalog"/"package" anywhere in the marketplace feature.
--
-- Also adds `installed_loops.object_id`, wiring the install flow (see
-- apps/dev/src/routes/installed-loops.ts) to the loops-first-class bet's
-- `objects.type = 'loop'` concept (commit 6871983b): installing a
-- marketplace loop now creates a running Loop object, linked back here.
--
-- Table/column renames:
--   catalog_packages            -> marketplace_loops
--   catalog_package_items       -> marketplace_loop_items
--     .package_id                -> .loop_id
--   installed_packages          -> installed_loops
--     .source_package_id         -> .source_loop_id
--     (new) .object_id           uuid references objects(id)
--   loop_active_days.installed_package_id -> .installed_loop_id
--
-- Metadata JSONB key renames (on actors, triggers, workspace_skills,
-- integrations — the four tables an install provisions rows into):
--   installed_package_id             -> installed_loop_id
--   forked_from_installed_package_id -> forked_from_installed_loop_id
--   catalog_item_id                  -> marketplace_item_id
--
-- None of these tables are on the hot-tables list in packages/db/MIGRATIONS.md
-- (ALTER TABLE ... RENAME is a metadata-only, near-instant operation anyway;
-- the JSONB UPDATEs below touch only install-provisioned rows, a small set
-- since the marketplace feature is new), so no CONCURRENTLY/chunking is
-- required.

ALTER TABLE catalog_packages RENAME TO marketplace_loops;
ALTER TABLE catalog_package_items RENAME TO marketplace_loop_items;
ALTER TABLE marketplace_loop_items RENAME COLUMN package_id TO loop_id;
ALTER TABLE installed_packages RENAME TO installed_loops;
ALTER TABLE installed_loops RENAME COLUMN source_package_id TO source_loop_id;
ALTER TABLE installed_loops ADD COLUMN IF NOT EXISTS object_id uuid REFERENCES objects(id);
ALTER TABLE loop_active_days RENAME COLUMN installed_package_id TO installed_loop_id;

-- Keep explicitly-named indexes/constraints in sync with packages/db/src/schema.ts
-- (the auto-generated pkey/fk/unique-column constraint names are left as-is —
-- they're never referenced by name in code, so renaming them is pure cosmetics
-- with real risk of a typo; not worth it).
ALTER INDEX catalog_package_items_package_idx RENAME TO marketplace_loop_items_loop_idx;
ALTER INDEX catalog_package_items_package_source_idx RENAME TO marketplace_loop_items_loop_source_idx;
ALTER TABLE marketplace_loop_items RENAME CONSTRAINT catalog_package_items_item_type_check TO marketplace_loop_items_item_type_check;
ALTER TABLE installed_loops RENAME CONSTRAINT installed_packages_ws_source_uniq TO installed_loops_ws_source_uniq;
ALTER INDEX installed_packages_source_locked_idx RENAME TO installed_loops_source_locked_idx;

-- JSONB key renames — idempotent via the `? 'old_key'` guard (a second run
-- finds no rows left carrying the old key and updates zero rows).
UPDATE actors SET metadata = (metadata - 'installed_package_id') || jsonb_build_object('installed_loop_id', metadata->'installed_package_id') WHERE metadata ? 'installed_package_id';
UPDATE actors SET metadata = (metadata - 'forked_from_installed_package_id') || jsonb_build_object('forked_from_installed_loop_id', metadata->'forked_from_installed_package_id') WHERE metadata ? 'forked_from_installed_package_id';
UPDATE actors SET metadata = (metadata - 'catalog_item_id') || jsonb_build_object('marketplace_item_id', metadata->'catalog_item_id') WHERE metadata ? 'catalog_item_id';

UPDATE triggers SET metadata = (metadata - 'installed_package_id') || jsonb_build_object('installed_loop_id', metadata->'installed_package_id') WHERE metadata ? 'installed_package_id';
UPDATE triggers SET metadata = (metadata - 'forked_from_installed_package_id') || jsonb_build_object('forked_from_installed_loop_id', metadata->'forked_from_installed_package_id') WHERE metadata ? 'forked_from_installed_package_id';
UPDATE triggers SET metadata = (metadata - 'catalog_item_id') || jsonb_build_object('marketplace_item_id', metadata->'catalog_item_id') WHERE metadata ? 'catalog_item_id';

UPDATE workspace_skills SET metadata = (metadata - 'installed_package_id') || jsonb_build_object('installed_loop_id', metadata->'installed_package_id') WHERE metadata ? 'installed_package_id';
UPDATE workspace_skills SET metadata = (metadata - 'forked_from_installed_package_id') || jsonb_build_object('forked_from_installed_loop_id', metadata->'forked_from_installed_package_id') WHERE metadata ? 'forked_from_installed_package_id';
UPDATE workspace_skills SET metadata = (metadata - 'catalog_item_id') || jsonb_build_object('marketplace_item_id', metadata->'catalog_item_id') WHERE metadata ? 'catalog_item_id';

UPDATE integrations SET metadata = (metadata - 'installed_package_id') || jsonb_build_object('installed_loop_id', metadata->'installed_package_id') WHERE metadata ? 'installed_package_id';
UPDATE integrations SET metadata = (metadata - 'forked_from_installed_package_id') || jsonb_build_object('forked_from_installed_loop_id', metadata->'forked_from_installed_package_id') WHERE metadata ? 'forked_from_installed_package_id';
UPDATE integrations SET metadata = (metadata - 'catalog_item_id') || jsonb_build_object('marketplace_item_id', metadata->'catalog_item_id') WHERE metadata ? 'catalog_item_id';
