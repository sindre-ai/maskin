-- Split the stored route timing counts by the app build that sent the request.
--
-- Until now "build" was only the server's own commit, so requests per minute could not be compared
-- between two iOS builds. client_build holds the iOS build number from the X-Client-Build header
-- (digits only, up to 12, checked in apps/dev/src/lib/request-timing.ts). Requests without a valid
-- header (web, agents) keep the empty default, so existing rows and the web path need no backfill.
--
-- Additive column, then the primary key is rebuilt to include it. The table is small (one row per
-- minute per route, 30 days) and not on the hot-tables list (see packages/db/MIGRATIONS.md); a
-- failed write there is logged and never fails a request. Both statements run in one go, so a
-- flush that lands in between waits for the key and then upserts into the new one.
-- Down: drizzle/down/0137_api_route_timing_client_build_down.sql.

ALTER TABLE "api_route_timing_minutes" ADD COLUMN IF NOT EXISTS "client_build" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" DROP CONSTRAINT IF EXISTS "api_route_timing_minutes_pkey";
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" ADD CONSTRAINT "api_route_timing_minutes_pkey" PRIMARY KEY ("minute", "build", "method", "route", "stream", "client_build");
