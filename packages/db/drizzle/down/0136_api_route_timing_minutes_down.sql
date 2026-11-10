-- Rollback for 0136_api_route_timing_minutes.sql. Drops the table and the counts in it.
-- Roll back the code that writes it first (the writer logs and carries on if the table is gone).
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "api_route_timing_minutes";
