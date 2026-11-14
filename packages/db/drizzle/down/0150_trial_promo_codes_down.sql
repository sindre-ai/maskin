-- Rollback for 0150_trial_promo_codes.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Dropping the table forgets every code and how often it was used. Workspaces that already started a
-- trial with a code keep it: they hold only the code's id in their billing settings, nothing reads
-- the table after the trial has started. With the flag off the card step does not run.
DROP TABLE IF EXISTS "trial_promo_codes";
