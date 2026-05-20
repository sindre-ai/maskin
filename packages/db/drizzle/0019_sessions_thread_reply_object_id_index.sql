-- Partial expression index mirroring 0018_sessions_mention_object_id_index.sql,
-- but covering sessions spawned by the thread-scoped auto-reply trigger (a new
-- comment landing in a thread an agent previously participated in). The
-- GET /api/sessions?mention_object_id=... filter ORs across both
-- config->'mention'->>'object_id' and config->'thread_reply'->>'object_id'
-- so the UI can attach a live activity card to either kind of trigger; this
-- index keeps the thread_reply branch as cheap as the mention branch.
CREATE INDEX IF NOT EXISTS "sessions_ws_thread_reply_object_idx"
	ON "sessions" ("workspace_id", ((config->'thread_reply'->>'object_id')))
	WHERE config->'thread_reply'->>'object_id' IS NOT NULL;
