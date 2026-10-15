-- S2 · widen the `relationships` CHECK constraint to admit two new endpoint
-- kinds (`conversation`, `session`), and add a nullable `metadata` jsonb
-- column that the writer hook uses to persist edge-level context (currently
-- the spawning `messageId` on a `conversation → session` `spawned` edge).
--
-- Prerequisite for the automatic provenance edges the writer hook lands in
-- the same PR:
--   * `conversation → session` (type='spawned') on session CREATE from a chat,
--     with `metadata->>'messageId'` = the message that triggered the spawn.
--   * `session → object|file` (type='produced_by') on a session-owned
--     mutation.
--
-- Ships live regardless of the `graph-provenance-writes` feature flag.
-- Schema-tolerance is safe with zero writes: no row can carry a new
-- source_type / target_type or a non-null metadata until the writer hook is
-- enabled per-actor via the flag, so widening here does not change any
-- observable behaviour on its own.
--
-- The CHECK is applied NOT VALID + VALIDATE, same discipline as 0046:
-- a plain ADD CONSTRAINT takes ACCESS EXCLUSIVE across the whole
-- `relationships` table for the validation scan, which is unacceptable on a
-- hot table. NOT VALID adds the constraint under a light lock and only
-- checks new writes; VALIDATE CONSTRAINT then re-scans existing rows under
-- SHARE UPDATE EXCLUSIVE so concurrent reads and writes are unaffected.
--
-- The new metadata column is nullable with no default, so ADD COLUMN
-- rewrites no rows — instant even on a large table.

ALTER TABLE "relationships" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT IF EXISTS "relationships_source_target_type_kind";
--> statement-breakpoint
ALTER TABLE "relationships"
  ADD CONSTRAINT "relationships_source_target_type_kind"
  CHECK (
    "source_type" IN ('object', 'file', 'conversation', 'session')
    AND "target_type" IN ('object', 'file', 'conversation', 'session')
  )
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "relationships"
  VALIDATE CONSTRAINT "relationships_source_target_type_kind";
