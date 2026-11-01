-- Release 2 of the per-thread session index change. The (conversation, agent) unique index
-- from 0055 allowed one live interactive session per agent per chat, which blocks thread
-- sessions. 0120 added sessions_conversation_actor_thread_active_uniq, which keeps the same
-- guard per (conversation, agent, thread) and treats the main chat (NULL thread) as thread 0,
-- so dropping this one does not allow duplicate main-chat sessions.
--
-- DROP INDEX CONCURRENTLY does not block writes on sessions and cannot run inside a
-- transaction block, so it is alone in its file per MIGRATIONS.md Rule 1.
-- Rollback is drizzle/down/0122_drop_sessions_conversation_actor_active_uniq_down.sql.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_conversation_actor_active_uniq";
