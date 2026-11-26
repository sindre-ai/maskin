-- Rollback for 0164. Drops the outcome check tables (and their indexes with them); nothing else
-- depends on them. After this, a job closes as it did before: no check, no stored rounds.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "job_outcomes";
DROP TABLE IF EXISTS "outcome_checks";
