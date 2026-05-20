-- Partial expression index to support per-object lookups of sessions spawned by
-- an @mention comment. GET /api/sessions?mention_object_id=... filters on
-- (workspace_id, config->'mention'->>'object_id'); without this index the
-- workspace predicate alone would force a scan + per-row JSONB extraction as
-- session volume grows. The WHERE clause keeps the index tiny by only covering
-- mention-triggered sessions (a small fraction of all sessions).
CREATE INDEX IF NOT EXISTS "sessions_ws_mention_object_idx"
	ON "sessions" ("workspace_id", ((config->'mention'->>'object_id')))
	WHERE config->'mention'->>'object_id' IS NOT NULL;
