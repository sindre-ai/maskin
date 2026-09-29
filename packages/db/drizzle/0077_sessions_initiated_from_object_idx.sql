-- Partial index on sessions.initiated_from_object_id, WHERE NOT NULL —
-- serves the future "which sessions did we spawn for this bet/task?"
-- lookup. Partial because the vast majority of rows have NULL for this
-- column (any session created without an originating object, i.e. every
-- session created before this migration, plus every direct-API / onboarding
-- session going forward).
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_initiated_from_object_idx"
	ON "sessions" ("initiated_from_object_id")
	WHERE "initiated_from_object_id" IS NOT NULL;
