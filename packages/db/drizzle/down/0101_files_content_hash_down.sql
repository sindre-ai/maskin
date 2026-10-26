-- Rollback for 0101_files_content_hash.sql. Lives under drizzle/down/ so the
-- forward migration runner never picks it up. Safe: the hash is derived data
-- and is recomputed from storage when the column comes back.
ALTER TABLE "files" DROP COLUMN IF EXISTS "content_hash";
