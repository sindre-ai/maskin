-- Live usage: a running chat now saves each turn's tokens and cost as the turn closes, so the
-- settle paths (pause, completion, timeout, idle close) must only add what is not saved yet.
--
-- usage_counted_log_id    highest session_logs.id whose `result` envelope is already in the
--                         session's usage columns. NULL = nothing counted yet.
-- usage_counted_cli_cost  the CLI's cumulative total_cost_usd (per CLI process) at that point, so
--                         the next write can add only the cost increment.
--
-- sessions is not on the hot-tables list (MIGRATIONS.md). Both columns are nullable with no
-- default, which is a metadata-only change, and no backfill is needed: NULL means "count every
-- result since the last resume marker", exactly what the settle paths did before.
-- Down: drizzle/down/0113_sessions_usage_watermark_down.sql.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "usage_counted_log_id" bigint;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "usage_counted_cli_cost" numeric(12, 6);
