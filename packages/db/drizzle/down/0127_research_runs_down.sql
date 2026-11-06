-- Rollback for 0127. Drops the research run table and the cost it recorded; the plan usage
-- sum then reads sessions only, as before 0127.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "research_runs";
