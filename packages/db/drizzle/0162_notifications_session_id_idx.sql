-- notifications.session_id -> sessions.id is ON DELETE SET NULL (migration 0041), so every session
-- deleted by an agent delete has to find its notifications. Nothing indexed the column, so each
-- deleted session scanned all of notifications (about 40k rows). Together with 0160 and 0161 this is
-- what pushes "delete from sessions where actor_id = $1" past the statement timeout.
--
-- Partial on IS NOT NULL: most notifications have no session.
--
-- Alone in its file (MIGRATIONS.md Rule 1). Down: drizzle/down/0162_notifications_session_id_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_session_id_idx"
  ON "notifications" USING btree ("session_id")
  WHERE "session_id" IS NOT NULL;
