-- Rollback for 0151. Drops the sweep's claim log (and its two indexes with it); nothing else
-- depends on the table. Objects and next steps are untouched.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "next_step_sweep_claims";
