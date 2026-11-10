-- Rollback for 0142_api_route_timing_client_build.sql. Keeps every count: rows that carried an
-- app build are added into the row with the empty build (same client_source), then removed, so the
-- primary key without client_build can be put back. The split per iOS build is lost; the split by
-- client_source (0137) stays.
-- Roll back the code that writes client_build first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

INSERT INTO "api_route_timing_minutes"
	("minute", "build", "method", "route", "stream", "client_source", "client_build", "requests",
	 "slow_requests", "errors_5xx", "total_ms_sum", "db_ms_sum", "db_queries")
SELECT "minute", "build", "method", "route", "stream", "client_source", '', sum("requests"),
	sum("slow_requests"), sum("errors_5xx"), sum("total_ms_sum"), sum("db_ms_sum"), sum("db_queries")
FROM "api_route_timing_minutes"
WHERE "client_build" <> ''
GROUP BY "minute", "build", "method", "route", "stream", "client_source"
ON CONFLICT ("minute", "build", "method", "route", "stream", "client_source", "client_build") DO UPDATE SET
	"requests" = "api_route_timing_minutes"."requests" + excluded."requests",
	"slow_requests" = "api_route_timing_minutes"."slow_requests" + excluded."slow_requests",
	"errors_5xx" = "api_route_timing_minutes"."errors_5xx" + excluded."errors_5xx",
	"total_ms_sum" = "api_route_timing_minutes"."total_ms_sum" + excluded."total_ms_sum",
	"db_ms_sum" = "api_route_timing_minutes"."db_ms_sum" + excluded."db_ms_sum",
	"db_queries" = "api_route_timing_minutes"."db_queries" + excluded."db_queries";
--> statement-breakpoint
DELETE FROM "api_route_timing_minutes" WHERE "client_build" <> '';
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" DROP CONSTRAINT IF EXISTS "api_route_timing_minutes_pkey";
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" DROP COLUMN IF EXISTS "client_build";
--> statement-breakpoint
ALTER TABLE "api_route_timing_minutes" ADD CONSTRAINT "api_route_timing_minutes_pkey" PRIMARY KEY ("minute", "build", "method", "route", "stream", "client_source");
