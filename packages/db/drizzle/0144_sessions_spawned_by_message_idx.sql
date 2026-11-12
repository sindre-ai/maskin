-- "Which sessions did this chat message spawn?" (services/spawned-sessions.ts) filters on
-- sessions.spawned_by_message_id, and the foreign key to the messages table is ON DELETE SET NULL,
-- so every message delete also has to find its spawned sessions. Nothing indexed the column, so
-- both scanned sessions.
--
-- Partial on IS NOT NULL: most sessions were not spawned from a message, so the index holds only
-- the few that were. Same shape as sessions_spawned_by_session_id_idx (migration 0090).
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). If an interrupted build leaves an INVALID index, drop it
-- first. Down: drizzle/down/0144_sessions_spawned_by_message_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_spawned_by_message_id_idx"
  ON "sessions" USING btree ("spawned_by_message_id")
  WHERE "spawned_by_message_id" IS NOT NULL;
