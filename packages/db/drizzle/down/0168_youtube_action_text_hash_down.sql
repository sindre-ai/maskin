-- Rollback for 0168_youtube_action_text_hash.sql. Drops the comment text hashes; the
-- "no identical comment twice" rule then has nothing to compare against until new comments are made.
-- Roll back the code that reads the column first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP INDEX IF EXISTS "youtube_pending_actions_text_hash_idx";
ALTER TABLE "youtube_pending_actions" DROP COLUMN IF EXISTS "text_hash";
