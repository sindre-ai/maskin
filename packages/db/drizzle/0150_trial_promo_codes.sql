-- Migration: trial_promo_codes — promo codes that start the 7-day trial with no card (bet "A card to
-- start a 7-day trial", task "Promo code on the start-trial page").
-- Why a table and not Stripe promotion codes: Stripe counts a redemption only when a code is applied
-- to a checkout or subscription, and a trial with no card has neither. So Stripe cannot say "this
-- code skips the card" and cannot count the use atomically for us. Our own row can.
-- A code is stored upper case. `redemptions` goes up by one inside the transaction that starts the
-- trial, by a single UPDATE that also checks the limit, so two people cannot take the last use.
-- New, empty table, not hot-listed: plain CREATE INDEX is fine. No triggers / pg_notify. No code is
-- created here; a person adds rows by hand (insert into trial_promo_codes (code, max_redemptions,
-- expires_at) values (...)). Idempotent — safe to re-run.
-- Down: drizzle/down/0150_trial_promo_codes_down.sql.

CREATE TABLE IF NOT EXISTS "trial_promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"max_redemptions" integer NOT NULL,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_promo_codes_max_positive" CHECK ("max_redemptions" > 0),
	CONSTRAINT "trial_promo_codes_within_max" CHECK ("redemptions" >= 0 AND "redemptions" <= "max_redemptions"),
	CONSTRAINT "trial_promo_codes_code_upper" CHECK ("code" = upper("code") AND "code" ~ '^[A-Z0-9_-]{4,64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trial_promo_codes_code_uniq" ON "trial_promo_codes" USING btree ("code");
