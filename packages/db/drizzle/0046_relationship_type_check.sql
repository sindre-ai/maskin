-- Storage-layer enforcement of the canonical source_type/target_type convention.
-- Per T1 Decision §2: every write path stamps 'object' or 'file' — never a
-- specialized type ('insight', 'bet', 'task', ...). This CHECK rejects any
-- INSERT/UPDATE that violates the convention.
--
-- Must be numbered AFTER T4's backfill migration (0045) so that existing
-- divergent rows are normalized before the constraint is applied.
ALTER TABLE "relationships"
  ADD CONSTRAINT "relationships_source_target_type_kind"
  CHECK ("source_type" IN ('object', 'file') AND "target_type" IN ('object', 'file'));