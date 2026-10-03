-- Partial index for the voice-outreach dial queue (voice-outreach bet).
--
-- The dialer tick reads contacts that are voice_queued and due, per workspace,
-- ordered by metadata->>'next_dial_at'. Partial on the contact + voice_queued
-- rows so it stays small however big objects gets. Contacts are objects rows
-- with type = 'contact'.
--
-- The key is the raw text, not (...)::timestamptz: text -> timestamptz is STABLE
-- not IMMUTABLE, so Postgres rejects it in an index expression (42P17). The
-- voice reducer is the only writer of next_dial_at and always writes
-- Date.toISOString() (fixed-width UTC, e.g. 2026-10-05T07:00:00.000Z), which sorts
-- chronologically as text. Queries must compare against the same format.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "objects_voice_queue_next_dial_idx"
	ON "objects" ("workspace_id", (("metadata"->>'next_dial_at')))
	WHERE "type" = 'contact' AND "status" = 'voice_queued';
