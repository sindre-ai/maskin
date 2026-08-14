-- Migration: add is_folder + file_count to workspace_skills so the table can
-- store folder-based skill bundles alongside the existing single-file skills.
-- is_folder defaults to false and file_count stays nullable, so every existing
-- single-file skill row keeps its current shape. Adding a column with a
-- constant default is a metadata-only change in Postgres 11+, so no table
-- rewrite. Idempotent — safe to re-run.

ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "is_folder" boolean NOT NULL DEFAULT false;

ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "file_count" integer;
