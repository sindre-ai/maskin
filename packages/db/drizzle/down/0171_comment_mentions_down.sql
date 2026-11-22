-- Rollback for 0171_comment_mentions.sql and 0172_backfill_comment_mentions.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
--
-- Roll the code back first (or at the same time): the old unread query reads `events` and does not
-- need this table, so nothing breaks once the code is reverted. Then drop the trigger, its
-- function and the table. The unread poll goes back to scanning comments: slower, never wrong.
-- The two files are recorded in "_migrations"; delete their rows too if you want to re-apply them.
DROP TRIGGER IF EXISTS "events_comment_mentions" ON "events";
DROP FUNCTION IF EXISTS comment_mentions_record();
DROP TABLE IF EXISTS "comment_mentions";
-- DELETE FROM "_migrations" WHERE name IN ('0171_comment_mentions.sql', '0172_backfill_comment_mentions.sql');
