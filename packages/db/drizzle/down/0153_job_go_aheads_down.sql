-- Rollback for 0153. Drops the go-ahead table (and its two indexes with it); nothing else depends
-- on it. After this, sessions simply see no go-ahead and ask again as they did before.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "job_go_aheads";
