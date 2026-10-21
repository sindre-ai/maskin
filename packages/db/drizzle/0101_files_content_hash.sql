-- Content hash for the safe file-save path. sha256 of the stored bytes,
-- lowercase hex, set on every write. Nullable and additive: existing rows keep
-- NULL and are hashed from storage on first read or first save (see
-- apps/dev/src/lib/file-save.ts), so there is no backfill here and no table
-- rewrite. 'files' is not on the hot tables list in MIGRATIONS.md.
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "content_hash" text;
