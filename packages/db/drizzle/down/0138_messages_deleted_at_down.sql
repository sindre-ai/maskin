-- Rollback for 0138_messages_deleted_at.sql. Drops the column; messages deleted meanwhile keep
-- their emptied content, so they show as blank messages instead of tombstones.
-- Roll back the code that writes deleted_at first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "messages" DROP COLUMN IF EXISTS "deleted_at";
