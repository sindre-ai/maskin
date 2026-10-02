-- Pro included-usage cap: $20 -> $49 on rows stuck at the old value.
--
-- Pro was raised from 2000 to 4900 cents in Sep 2026, but prod's
-- MASKIN_PRO_HARD_CAP_USD_CENTS env still held an old value, and the Stripe
-- webhook rewrote billing.hard_cap_usd_cents from that env on every
-- subscription event. The code now ignores that env for Pro and Team
-- (lib/billing-defaults.ts), so this migration corrects the rows already
-- stored at the old value. Shipped in the same deploy as the code change so no
-- webhook can write 2000 back in between.
--
-- Guarded, no workspace ids: only plan = 'pro' rows whose stored cap is exactly
-- 2000 move to 4900. Team, trial, enterprise, and Pro rows with any other cap
-- are untouched. Idempotent: a second run matches no rows because the first
-- run moved them off 2000.
--
-- `workspaces` is not on the hot tables list in MIGRATIONS.md and the guard
-- bounds the write to a handful of rows, so the chunked-backfill recipe
-- (Rule 2) does not apply.
UPDATE "workspaces"
SET "settings" = jsonb_set("settings", '{billing,hard_cap_usd_cents}', to_jsonb(4900), false),
	"updated_at" = now()
WHERE "settings"->'billing'->>'plan' = 'pro'
	AND "settings"->'billing'->>'hard_cap_usd_cents' = '2000';
