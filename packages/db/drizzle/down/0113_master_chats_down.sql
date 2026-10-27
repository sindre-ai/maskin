-- Rollback for 0113. Drops the master chat pointers. The conversations they pointed at are not
-- touched: they stay as ordinary two-person chats. Nothing else references this table.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "master_chats";
