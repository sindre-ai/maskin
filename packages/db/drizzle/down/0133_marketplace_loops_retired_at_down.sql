-- Rollback for 0133. Drops the retired_at column; every marketplace loop becomes listed again.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "marketplace_loops" DROP COLUMN IF EXISTS "retired_at";
