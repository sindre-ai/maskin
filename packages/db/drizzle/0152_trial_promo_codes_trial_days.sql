-- Migration: trial_promo_codes.trial_days — how many days the trial lasts for a person who starts it
-- with this code (task "Promo code gives a 14-day trial", bet "A card to start a 7-day trial").
-- A trial started with a card stays 7 days; only a code carries its own length.
-- Two steps so existing codes do not change: the column is added with 7 (what every code gave
-- before, so each row that exists now keeps giving 7), then the default for NEW codes is set to 14.
-- A person moves an existing code to 14 by hand: update trial_promo_codes set trial_days = 14
-- where code = '...'. Trials that already started hold their own period_end and are not touched.
-- Adds a column with a constant default (no table rewrite on Postgres 11+). No triggers / pg_notify.
-- Idempotent — safe to re-run.
-- Down: drizzle/down/0152_trial_promo_codes_trial_days_down.sql.

ALTER TABLE "trial_promo_codes" ADD COLUMN IF NOT EXISTS "trial_days" integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" ALTER COLUMN "trial_days" SET DEFAULT 14;
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" DROP CONSTRAINT IF EXISTS "trial_promo_codes_trial_days_positive";
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" ADD CONSTRAINT "trial_promo_codes_trial_days_positive" CHECK ("trial_days" > 0);
