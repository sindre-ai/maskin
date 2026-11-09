-- Soft delete for chat messages: the author deletes a message by emptying it, and deleted_at
-- records when. The row stays so thread roots, replies and read markers keep pointing at it.
-- Rows that exist today are live, so they stay null and need no backfill.
--
-- Additive nullable column with no default: a metadata-only change in Postgres, no table rewrite.
-- Down: drizzle/down/0138_messages_deleted_at_down.sql.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
