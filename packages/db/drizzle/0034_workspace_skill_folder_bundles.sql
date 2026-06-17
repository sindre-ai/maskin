-- Folder skills: a workspace_skills row can now represent either a single
-- SKILL.md file (default) or a multi-file bundle uploaded as a zip.
--
-- `is_folder` is the type discriminator. `bundle_prefix` holds the S3 prefix
-- for the rest of the bundle when `is_folder` is true; the existing
-- `storage_key`, `content`, and `size_bytes` columns continue to point at the
-- SKILL.md entrypoint in either case, so read paths that load the entrypoint
-- do not need to branch on `is_folder`.
--
-- workspace_skills is not on the hot-tables list (see packages/db/MIGRATIONS.md).
-- The ADD COLUMN with a constant default is a metadata-only operation in
-- Postgres >= 11 and does not rewrite the table.
ALTER TABLE "workspace_skills"
ADD COLUMN "is_folder" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "workspace_skills"
ADD COLUMN "bundle_prefix" text;
