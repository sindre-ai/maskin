-- notifications.object_id -> objects.id is ON DELETE SET NULL (migration 0004), so every object
-- deleted has to find its notifications. Nothing indexed the column, so each deleted object scanned
-- all of notifications (44k rows, 36 ms per scan on production). A workspace delete removes objects
-- 500 at a time, which is about 18 seconds of scanning in one statement, past the 45 second query
-- timeout once the other cascades and normal traffic are added (Sentry MASKIN-DEV-4Y).
--
-- Partial on IS NOT NULL: most notifications are not about an object.
--
-- `notifications` is written on every mention and status change, so the build is CONCURRENTLY and
-- alone in its file (MIGRATIONS.md Rule 1). Down: drizzle/down/0167_notifications_object_id_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_object_id_idx"
  ON "notifications" USING btree ("object_id")
  WHERE "object_id" IS NOT NULL;
