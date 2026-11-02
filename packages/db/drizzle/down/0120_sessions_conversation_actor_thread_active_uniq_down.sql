-- Rollback for 0120. Drops the per-thread unique index; the old (conversation, agent) index
-- from 0055 is still in place and keeps guarding against a double spawn.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP INDEX CONCURRENTLY IF EXISTS "sessions_conversation_actor_thread_active_uniq";
