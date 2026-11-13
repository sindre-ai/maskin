-- Split the stored route timing counts by the app release that sent the request.
--
-- client_build (0149) tells two iOS builds apart but not which release (1.1, 1.2) they belong to.
-- client_version holds the iOS marketing version from the X-Client-Version header (digits and dots
-- only, up to 12 characters, checked in apps/dev/src/lib/request-timing.ts). Requests without a
-- valid header (web, agents) keep the empty default, so existing rows and the web path need no
-- backfill.
-- Comes after 0149_api_route_timing_client_build.sql: the primary key keeps client_build and adds
-- client_version, so the splits work together.
--
-- Additive column, then the primary key is rebuilt to include it. The table is small (one row per
-- minute per route, 30 days) and not on the hot-tables list (see packages/db/MIGRATIONS.md); a
-- failed write there is logged and never fails a request. All statements run in one go, so a
-- flush that lands in between waits for the key and then upserts into the new one.
-- Down: drizzle/down/0150_api_route_timing_client_version_down.sql.

ALTER TABLE "api_route_timing_minutes" ADD COLUMN IF NOT EXISTS "client_version" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" DROP CONSTRAINT IF EXISTS "api_route_timing_minutes_pkey";
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" ADD CONSTRAINT "api_route_timing_minutes_pkey" PRIMARY KEY ("minute", "build", "method", "route", "stream", "client_source", "client_build", "client_version");
