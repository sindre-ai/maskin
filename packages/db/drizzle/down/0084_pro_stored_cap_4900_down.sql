-- Rollback for 0084_pro_stored_cap_4900.sql. Sets Pro workspaces stored at 4900
-- back to 2000. Lives under drizzle/down/ so the forward migration runner never
-- picks it up.
--
-- Caveat: this cannot tell rows the forward migration changed from Pro rows that
-- were already (or later became) 4900 through a Stripe event, so it moves all of
-- them. Only run it together with a revert of the code change; with that code
-- deployed, 2000 is the wrong cap for Pro.
UPDATE "workspaces"
SET "settings" = jsonb_set("settings", '{billing,hard_cap_usd_cents}', '2000'::jsonb)
WHERE "settings" -> 'billing' ->> 'plan' = 'pro'
	AND "settings" -> 'billing' ->> 'hard_cap_usd_cents' = '4900';
