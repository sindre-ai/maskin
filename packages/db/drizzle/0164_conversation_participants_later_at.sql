-- Later on a chat, per person (task "Make the server say which chats need you").
--
-- conversation_participants.later_at: when this person put the chat on Later, null when they have
-- not. A chat counts as Later only while no message has arrived since (later_at is not before the
-- chat's last_message_at), so a new message brings it back with nothing written to anyone's row.
-- The column sits on the person's own participant row, so it is never shared.
--
-- Nullable column with no default: no table rewrite, existing rows stay null (not on Later).
-- conversation_participants is not on the hot-tables list (packages/db/MIGRATIONS.md), so a plain
-- ALTER is fine. Nothing reads or writes it until the new routes ship.
-- Down: drizzle/down/0164_conversation_participants_later_at_down.sql.

ALTER TABLE "conversation_participants" ADD COLUMN IF NOT EXISTS "later_at" timestamp with time zone;
