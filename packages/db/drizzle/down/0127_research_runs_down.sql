-- Rollback for 0119. Drops the research run table and the cost it recorded; the plan usage
-- sum then reads sessions only, as before 0119.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "research_runs";
