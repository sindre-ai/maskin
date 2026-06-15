-- Migration: editorial `is_featured` flag on catalog_packages.
--
-- T8's package-card grid ships without a featured strip because the
-- previous heuristic (item_types.length > 1) surfaces packages by accident
-- of composition, not editorial intent. This column gives Maskin a single
-- bit to mark a package as featured. The /marketplace route renders a
-- horizontal `FeaturedStrip` above the `PackageGrid` for rows where
-- `is_featured = true`.
--
-- Default false on existing rows. catalog_packages is not on the hot path
-- (no foreign-traffic writes), so a plain ADD COLUMN is fine — Postgres
-- emits a fast default that does not rewrite the table.
--
-- We also flip the Customer Continuous Discovery row (published by T10)
-- to `is_featured = true` here, so already-migrated databases that already
-- have the package row pick the feature up without re-running the publish
-- script. New publishes set the column directly via the publish script.

ALTER TABLE "catalog_packages"
	ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false;

UPDATE "catalog_packages"
	SET "is_featured" = true
	WHERE "slug" = 'customer-continuous-discovery';
