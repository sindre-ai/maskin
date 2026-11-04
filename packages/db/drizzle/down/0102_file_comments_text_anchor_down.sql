-- Rollback for 0102_file_comments_text_anchor.sql. Lives under drizzle/down/ so
-- the forward migration runner never picks it up. Drops any stored anchors;
-- the comments themselves stay and show as unanchored.
ALTER TABLE "file_comments" DROP COLUMN IF EXISTS "text_anchor";
