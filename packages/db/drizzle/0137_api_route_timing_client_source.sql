-- Split the stored route timing counts by who sent the request.
--
-- The counts could not tell web requests from iOS or agent requests, but the "events carry the
-- change" bet is judged on web only. client_source holds one of five fixed values, mapped in
-- apps/dev/src/lib/request-timing.ts from the X-Client-Source header: ui (web), ios, mcp (agents),
-- other (any other header text) and none (no header). The raw header is never stored. Rows written
-- before this change get the empty default, so they stay in the all-traffic sum and need no backfill.
--
-- Additive column, then the primary key is rebuilt to include it. The table is small (one row per
-- minute per route, 30 days) and not on the hot-tables list (see packages/db/MIGRATIONS.md); a
-- failed write there is logged and never fails a request. Both statements run in one go, so a
-- flush that lands in between waits for the key and then upserts into the new one.
-- Down: drizzle/down/0137_api_route_timing_client_source_down.sql.

ALTER TABLE "api_route_timing_minutes" ADD COLUMN IF NOT EXISTS "client_source" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" DROP CONSTRAINT IF EXISTS "api_route_timing_minutes_pkey";
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" ADD CONSTRAINT "api_route_timing_minutes_pkey" PRIMARY KEY ("minute", "build", "method", "route", "stream", "client_source");
