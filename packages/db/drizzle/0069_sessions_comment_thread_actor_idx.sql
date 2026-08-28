-- Lookup path for routeCommentToAgent's find-existing-session query, which
-- also matches pending/starting/queued and so isn't covered by the partial
-- unique index in 0068. CONCURRENTLY + alone in its file per MIGRATIONS.md.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_comment_thread_actor_idx"
	ON "sessions" ("comment_thread_root_event_id", "actor_id")
	WHERE "comment_thread_root_event_id" IS NOT NULL;
