-- Rollback for 0159. Drops the done-when tables (and their indexes with them); nothing else
-- depends on them. After this, jobs simply have no done-when list and work as they did before.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "done_when_skips";
DROP TABLE IF EXISTS "done_when_lines";
