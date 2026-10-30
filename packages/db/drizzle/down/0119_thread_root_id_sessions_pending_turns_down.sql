-- Rollback for 0119. Drops the thread columns; every session and buffered turn is main chat
-- again, which is what the code from before the columns assumes. Run 0120's rollback first:
-- the index uses sessions.thread_root_id, so the column cannot drop while it exists.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "conversation_pending_turns" DROP COLUMN IF EXISTS "thread_root_id";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "thread_root_id";
