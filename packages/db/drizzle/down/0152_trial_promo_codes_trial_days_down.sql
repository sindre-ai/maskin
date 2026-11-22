-- Rollback for 0152_trial_promo_codes_trial_days.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Every code goes back to a 7 day trial. Workspaces that already started a trial keep the end date
-- they were given (it is stored on the workspace), so a 14 day trial already running is not cut short.
ALTER TABLE "trial_promo_codes" DROP CONSTRAINT IF EXISTS "trial_promo_codes_trial_days_positive";
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" DROP COLUMN IF EXISTS "trial_days";
