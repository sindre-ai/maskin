-- Rollback for 0177_search_opens.sql. Drops every recorded search open; the boost starts again from
-- nothing. Roll back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "search_opens";
