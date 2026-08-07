-- Authoritative guard against double-spawning two interactive sessions for
-- the same (conversation, agent) pair under a race — the application-level
-- lookup-then-insert in conversation-responder.ts is a fast path, not the
-- source of truth. CONCURRENTLY + alone in its file per MIGRATIONS.md Rule 1.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "sessions_conversation_actor_active_uniq"
	ON "sessions" ("conversation_id", "actor_id")
	WHERE "interactive" = true AND "status" IN ('pending', 'starting', 'running');
