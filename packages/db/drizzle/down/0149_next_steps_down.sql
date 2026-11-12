-- Rollback for 0149. Drops the next steps (and their two indexes with them); nothing else
-- depends on the table. Objects are untouched.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "next_steps";
