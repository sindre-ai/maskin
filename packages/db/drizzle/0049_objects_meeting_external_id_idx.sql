-- DB-side backstop for the check-then-insert TOCTOU race in the Skjald
-- meeting-webhook upsert (apps/dev/src/lib/integrations/providers/skjald/meeting-sync.ts).
-- upsertSkjaldMeeting looks up an existing `meeting` object by
-- metadata->>'external_id' before deciding to insert or update; two
-- concurrent deliveries for the same Skjald meeting_id (e.g. a webhook retry
-- racing the original delivery) could otherwise both pass that read and
-- insert duplicate meeting objects. This partial unique index gives Postgres
-- the last word, mirroring objects_ws_knowledge_title_unique_idx's pattern
-- (packages/db/drizzle/0047_knowledge_partial_unique_title_idx.sql).
--
-- `CREATE INDEX CONCURRENTLY` per packages/db/MIGRATIONS.md Rule 1: kept as
-- the only statement in this file so no future edit can wrap it in a BEGIN
-- and silently leave an INVALID index behind. `IF NOT EXISTS` makes a retry
-- safe if a previous CONCURRENTLY build was interrupted.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "objects_ws_meeting_external_id_unique_idx"
	ON "objects" ("workspace_id", (metadata->>'external_id'))
	WHERE "type" = 'meeting' AND metadata->>'external_id' IS NOT NULL;
