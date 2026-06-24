-- Migration: add annotations column to files so pinned review comments
-- persist on the row and round-trip to every reader (UI + MCP get_file)
-- without an extra S3 fetch. Defaults to an empty array for existing rows.
-- Adding a column with a constant default is a metadata-only change in
-- Postgres 11+, so no table rewrite. Idempotent — safe to re-run.

ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb;
