-- Rollback for 0122. Recreates the (conversation, agent) unique index from 0055. It fails if
-- a chat has two live interactive sessions for one agent (thread sessions); end those first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "sessions_conversation_actor_active_uniq"
	ON "sessions" ("conversation_id", "actor_id")
	WHERE "interactive" = true AND "status" IN ('pending', 'starting', 'running');
