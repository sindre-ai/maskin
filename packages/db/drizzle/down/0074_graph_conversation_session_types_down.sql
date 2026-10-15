-- Rollback for 0074_graph_conversation_session_types.sql. Narrows the
-- `relationships` CHECK constraint back to ('object', 'file'), drops the new
-- `metadata` column, and first removes every row whose source_type or
-- target_type is one of the new endpoint kinds ('conversation', 'session') —
-- otherwise the constraint would fail to validate the existing data.
--
-- Deleting the provenance rows is the correct rollback semantics: the writer
-- hook (`produced_by`, `spawned`) is the sole producer of those edges, so
-- removing the CHECK also means removing the writes that only the wider
-- CHECK made valid. There is no user-authored data at those endpoint types to
-- preserve (per §No-gos, users never write session or conversation edges by
-- hand). Dropping `metadata` afterwards is safe because the only writer that
-- populates it is the same hook: existing edges with metadata (spawned) are
-- deleted above.
--
-- Lives under `drizzle/down/` so the forward-migration runner never picks it
-- up — same carve-out as `meta/`. Invoked explicitly from the reversibility
-- test in `apps/dev/src/__tests__/integration/graph-provenance.test.ts`, via
-- psql on this file's contents. Round-trip up → down → up leaves the database
-- in the same shape it started in.

DELETE FROM "relationships"
WHERE "source_type" IN ('conversation', 'session')
   OR "target_type" IN ('conversation', 'session');
--> statement-breakpoint
ALTER TABLE "relationships" DROP CONSTRAINT IF EXISTS "relationships_source_target_type_kind";
--> statement-breakpoint
ALTER TABLE "relationships"
  ADD CONSTRAINT "relationships_source_target_type_kind"
  CHECK ("source_type" IN ('object', 'file') AND "target_type" IN ('object', 'file'));
--> statement-breakpoint
ALTER TABLE "relationships" DROP COLUMN IF EXISTS "metadata";
