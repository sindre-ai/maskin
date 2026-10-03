-- Partial index for the voice-outreach dial queue (voice-outreach bet).
--
-- The dialer tick reads contacts that are voice_queued and due, per workspace,
-- ordered by metadata->>'next_dial_at'. Partial on the contact + voice_queued
-- rows so it stays small however big objects gets. Contacts are objects rows
-- with type = 'contact'.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_voice_queue_next_dial_idx"
	ON "objects" ("workspace_id", (("metadata"->>'next_dial_at')::timestamptz))
	WHERE "type" = 'contact' AND "status" = 'voice_queued';
