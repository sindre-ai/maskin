-- Rollback for 0125. Drops the For You withdrawals; nothing else depends on it. Cards
-- withdrawn through it come back on the next load.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "for_you_withdrawals";
