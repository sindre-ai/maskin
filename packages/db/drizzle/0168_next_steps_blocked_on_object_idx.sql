-- next_steps.blocked_on_object_id -> objects.id is ON DELETE CASCADE (migration 0155), and nothing
-- indexed the column, so every deleted object scanned all of next_steps. Same cause as 0167: the
-- objects step of a workspace delete runs out of time.
--
-- Partial on IS NOT NULL: most next steps are not blocked on an object.
--
-- Alone in its file (MIGRATIONS.md Rule 1). Down: drizzle/down/0168_next_steps_blocked_on_object_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "next_steps_blocked_on_object_idx"
  ON "next_steps" USING btree ("blocked_on_object_id")
  WHERE "blocked_on_object_id" IS NOT NULL;
