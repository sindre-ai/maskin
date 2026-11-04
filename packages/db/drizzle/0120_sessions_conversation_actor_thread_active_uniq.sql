-- At most one live interactive session per (conversation, agent, thread). COALESCE maps the
-- main chat (NULL thread) to 0, a value no message id takes, so two main-chat sessions
-- collide: a plain index on thread_root_id would treat NULLs as distinct and allow both.
-- COALESCE instead of NULLS NOT DISTINCT so nothing depends on the Postgres version.
--
-- Added next to sessions_conversation_actor_active_uniq (0055), which stays until a later
-- release drops it: while it exists, a second live session for the same agent in a chat is
-- still rejected, so behaviour does not change yet. CONCURRENTLY + alone in its file per
-- MIGRATIONS.md Rule 1. Rollback is drizzle/down/0120_sessions_conversation_actor_thread_active_uniq_down.sql.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "sessions_conversation_actor_thread_active_uniq"
	ON "sessions" ("conversation_id", "actor_id", (COALESCE("thread_root_id", 0)))
	WHERE "interactive" = true AND "status" IN ('pending', 'starting', 'running');
