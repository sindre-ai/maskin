-- CONCURRENTLY per MIGRATIONS.md Rule 1 — sessions already has a prior
-- CONCURRENTLY precedent (0044_sessions_ws_updated_at_idx.sql). Alone in its
-- file since CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_conversation_actor_idx"
	ON "sessions" ("conversation_id", "actor_id")
	WHERE "conversation_id" IS NOT NULL;
