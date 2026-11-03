-- Thread-aware chat sessions, release 1 of 2 (expand): a nullable thread_root_id on the
-- session row and on the buffered turn, the same type as messages.thread_root_id (a message
-- id). NULL means the main chat, which is every row that exists today.
--
-- Nothing reads or writes the columns for a thread yet, and old code ignores them, so a
-- revert loses nothing. Both are nullable with no default, so Postgres adds them without
-- rewriting the table (MIGRATIONS.md Rule 3). Neither table is on the hot-tables list.
-- The new unique index is in 0120, alone in its file. The old index is dropped in a later
-- release. Rollback is drizzle/down/0119_thread_root_id_sessions_pending_turns_down.sql.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "thread_root_id" bigint;
--> statement-breakpoint
ALTER TABLE "conversation_pending_turns" ADD COLUMN IF NOT EXISTS "thread_root_id" bigint;
