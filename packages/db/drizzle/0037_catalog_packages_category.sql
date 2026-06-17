-- Migration: add `category` to catalog_packages so the storefront tab filter
-- (T4) can distinguish job-loop packages from the Customer Continuous Discovery
-- package and any future package classes.
--
-- catalog_packages is NOT on the hot-tables list (only webhook_deliveries is),
-- so plain ALTER TABLE is correct here. The column is nullable with no default,
-- so the add does not rewrite existing rows.

ALTER TABLE "catalog_packages" ADD COLUMN IF NOT EXISTS "category" text;
