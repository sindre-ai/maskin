-- Rooms: one flag on chats, false by default.
--
-- conversations.is_room marks a named, long-lived chat a person made a room on purpose. Adding a
-- column with a constant default does not rewrite the table (Postgres 11+), and conversations is
-- not on the hot-tables list (packages/db/MIGRATIONS.md), so a plain ALTER is fine. No back-fill:
-- every existing chat stays a plain chat.
-- Down: drizzle/down/0149_conversations_is_room_down.sql.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "is_room" boolean DEFAULT false NOT NULL;
