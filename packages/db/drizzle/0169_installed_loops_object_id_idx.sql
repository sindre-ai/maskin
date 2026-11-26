-- installed_loops.object_id -> objects.id is NO ACTION (migration 0051), and nothing indexed the
-- column, so every deleted object scanned all of installed_loops to check it. Same cause as 0167.
--
-- Partial on IS NOT NULL: a flow installed before the column existed has none.
--
-- Alone in its file (MIGRATIONS.md Rule 1). Down: drizzle/down/0169_installed_loops_object_id_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "installed_loops_object_id_idx"
  ON "installed_loops" USING btree ("object_id")
  WHERE "object_id" IS NOT NULL;
