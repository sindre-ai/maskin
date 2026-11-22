-- Rollback for 0144_trial_cards.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Dropping the table forgets which cards have had a trial, so those cards could start another.
-- Nothing else reads it: with the flag off the card step does not run.
DROP TABLE IF EXISTS "trial_cards";
