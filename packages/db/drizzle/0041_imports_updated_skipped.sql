-- Bulk imports run with configurable dedup keys split their per-row
-- outcomes four ways: created, updated, skipped, failed. The `imports`
-- row already tracked the first and last; `updated` and `skipped` had no
-- home and the UI was inferring them from the audit table on every read.
-- Persist them as plain counters so list endpoints stay cheap.
--
-- Additive, no backfill: pre-migration imports have no dedup-key writes
-- and so the correct historical value for both new counters is zero, which
-- is the column default.
--
-- To revert: ALTER TABLE "imports" DROP COLUMN "updated_count", DROP COLUMN "skipped_count";

ALTER TABLE "imports" ADD COLUMN "updated_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "imports" ADD COLUMN "skipped_count" integer NOT NULL DEFAULT 0;
