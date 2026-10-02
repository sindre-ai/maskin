-- Data fix: Pro included usage is $49 (Stripe price moved $20 -> $49 on
-- 2026-09-18), but Pro workspaces whose Stripe webhook ran while the prod
-- MASKIN_PRO_HARD_CAP_USD_CENTS env still held 2000 have that stale value
-- stored in settings.billing.hard_cap_usd_cents, and enforcement/display read
-- the stored cap before the code constant. The code in this same release stops
-- reading the env, so nothing writes 2000 back after this runs.
--
-- Bounded, idempotent, no id list: only plan = 'pro' rows still at exactly
-- 2000 are touched (2 rows in prod at the time of writing). `workspaces` is not
-- on the hot-tables list and the WHERE clause bounds the write, so the
-- chunked-backfill recipe in MIGRATIONS.md is not needed.
UPDATE "workspaces"
SET "settings" = jsonb_set("settings", '{billing,hard_cap_usd_cents}', '4900'::jsonb),
	"updated_at" = now()
WHERE "settings" #> '{billing,plan}' = '"pro"'::jsonb
	AND "settings" #> '{billing,hard_cap_usd_cents}' = '2000'::jsonb;
