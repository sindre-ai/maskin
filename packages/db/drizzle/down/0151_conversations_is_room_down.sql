-- Rollback for 0151_conversations_is_room.sql. Drops the room flag from every chat; the chats
-- themselves stay, as plain chats. Roll back the code that reads it first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "conversations" DROP COLUMN IF EXISTS "is_room";
