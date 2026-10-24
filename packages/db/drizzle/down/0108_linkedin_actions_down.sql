-- Rollback for 0108. Drops the LinkedIn action log. The rows are a measurement and cap record,
-- so rolling back loses the caps' history; the code that reads it must be rolled back first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "linkedin_actions";
