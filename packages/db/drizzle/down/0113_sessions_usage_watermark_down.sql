-- Rollback for 0113. Drops the usage watermark; settle paths fall back to counting every result
-- since the last resume marker.
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "usage_counted_cli_cost";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "usage_counted_log_id";
