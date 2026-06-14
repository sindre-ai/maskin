-- Partial UNIQUE index on (workspace_id, lower(metadata->>'email')) for type='contact'.
-- Serves two purposes:
--   1. Conflict target for INSERT ... ON CONFLICT DO NOTHING in upsertContactByEmail,
--      so two parallel Summarization Agent runs cannot race-create duplicate contacts
--      for the same attendee email.
--   2. Index for the contact-email lookup at services/attendee-contact.ts, which
--      otherwise sequential-scans `objects` on workspaces with many contacts.
-- `objects` is not in the hot-tables list (packages/db/MIGRATIONS.md), so a plain
-- CREATE UNIQUE INDEX is fine.
CREATE UNIQUE INDEX IF NOT EXISTS objects_contact_email_lower_uniq
  ON objects (workspace_id, (lower((metadata->>'email'))))
  WHERE type = 'contact';
