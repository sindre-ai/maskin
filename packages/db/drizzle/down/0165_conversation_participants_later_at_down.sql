-- Rollback for 0165_conversation_participants_later_at.sql. Drops everyone's Later marks, which
-- cannot be rebuilt: the chats go back to the normal list. Roll back the code that reads the
-- column first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "conversation_participants" DROP COLUMN IF EXISTS "later_at";
