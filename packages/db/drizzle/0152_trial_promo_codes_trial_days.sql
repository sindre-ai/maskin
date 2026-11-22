-- Migration: trial_promo_codes.trial_days — how many days the trial lasts for a person who starts it
-- with this code (task "Promo code gives a 14-day trial", bet "A card to start a 7-day trial").
-- A trial started with a card stays 7 days; only a code carries its own length.
-- Every code gives 14 days, the ones that exist now included: the column is added with DEFAULT 14,
-- so existing rows get 14 too. (The table is not on main yet, so no live code has promised 7.)
-- A person can set one code to another length by hand: update trial_promo_codes set trial_days = 7
-- where code = '...'. Trials that already started hold their own period_end and are not touched.
-- Adds a column with a constant default (no table rewrite on Postgres 11+). No triggers / pg_notify.
-- Idempotent — safe to re-run.
-- Down: drizzle/down/0152_trial_promo_codes_trial_days_down.sql.

ALTER TABLE "trial_promo_codes" ADD COLUMN IF NOT EXISTS "trial_days" integer DEFAULT 14 NOT NULL;
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" DROP CONSTRAINT IF EXISTS "trial_promo_codes_trial_days_positive";
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" ADD CONSTRAINT "trial_promo_codes_trial_days_positive" CHECK ("trial_days" > 0);
