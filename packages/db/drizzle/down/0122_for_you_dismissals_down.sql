-- Rollback for 0122. Drops the For You dismissals; nothing else depends on it. Cards
-- dismissed through it come back on the next load.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "for_you_dismissals";
