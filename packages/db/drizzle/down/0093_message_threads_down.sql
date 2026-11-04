-- Rollback for 0093_message_threads.sql. Thread replies stay as ordinary messages in the
-- main timeline once the pointer is gone; thread read cursors are lost.
DROP TABLE IF EXISTS "message_thread_reads";
DROP INDEX IF EXISTS "messages_thread_root_idx";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "thread_also_in_channel";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "thread_root_id";
