-- Backfill: config.conversation has only existed since 0051_conversations.sql
-- shipped (the Chats feature is brand new), so the qualifying row count is
-- small and bounded — a single guarded UPDATE, not the chunked-procedure
-- recipe in MIGRATIONS.md Rule 2, which is why this is called out explicitly
-- rather than skipped silently. If this table's row count against real data
-- turns out to be large by the time this runs, switch to the chunked
-- procedure pattern instead.
UPDATE "sessions"
SET "conversation_id" = (config->'conversation'->>'conversation_id')::uuid
WHERE config ? 'conversation'
  AND "conversation_id" IS NULL;
