-- Authoritative guard against double-spawning two interactive sessions for the
-- same (comment thread root, agent) pair under a race — the application-level
-- lookup-then-insert in routes/events.ts routeCommentToAgent is a fast path,
-- not the source of truth. Mirrors sessions_conversation_actor_active_uniq
-- (0055). CONCURRENTLY + alone in its file per MIGRATIONS.md Rule 1.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "sessions_comment_thread_actor_active_uniq"
	ON "sessions" ("comment_thread_root_event_id", "actor_id")
	WHERE "interactive" = true AND "status" IN ('pending', 'starting', 'running');
