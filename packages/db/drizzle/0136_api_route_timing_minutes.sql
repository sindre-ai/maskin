-- Keep the API's per-route timing counts, so a week of load per route can be read afterwards.
--
-- Until now the API only printed one timing line per route per minute and nothing kept it. This
-- table holds the same numbers: one row per minute, per route, per app build. Counts and sums only,
-- no actor, workspace or URL. The primary key starts with the minute, so the 30 day cleanup is a
-- range scan on it and no second index is needed. Rows from replicas or from two flushes in one
-- minute add into the same row (upsert in apps/dev/src/lib/route-timing-store.ts).
--
-- New table, nothing existing is touched, and it is not on the hot-tables list (see
-- packages/db/MIGRATIONS.md): a failed write there is logged and never fails a request.
-- Row security is on, like every other table in public (migration 0111): the app role owns the
-- table and keeps full access, anon and authenticated see nothing.
-- Down: drizzle/down/0136_api_route_timing_minutes_down.sql.

CREATE TABLE IF NOT EXISTS "api_route_timing_minutes" (
	"minute" timestamp with time zone NOT NULL,
	"build" text NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"stream" boolean NOT NULL,
	"requests" integer NOT NULL,
	"slow_requests" integer NOT NULL,
	"errors_5xx" integer NOT NULL,
	"total_ms_sum" double precision NOT NULL,
	"db_ms_sum" double precision NOT NULL,
	"db_queries" integer NOT NULL,
	CONSTRAINT "api_route_timing_minutes_pkey" PRIMARY KEY ("minute", "build", "method", "route", "stream")
);
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" ENABLE ROW LEVEL SECURITY;
