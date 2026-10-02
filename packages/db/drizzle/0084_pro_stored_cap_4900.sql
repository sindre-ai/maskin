-- Pro workspaces stored a hard cap of 2000 cents ($20) instead of 4900 ($49),
-- because every Stripe subscription event rewrote settings.billing.hard_cap_usd_cents
-- from the MASKIN_PRO_HARD_CAP_USD_CENTS env, and prod's value was stale. The
-- code no longer reads that env for Pro or Team, so this corrects the rows the
-- old env already wrote. Ships in the same deploy as that code change so no
-- webhook can write 2000 back in between.
--
-- No id list: the guard (plan is pro AND stored cap is exactly 2000) matches
-- only the affected rows and is idempotent. Team, trial and any Pro workspace
-- with another stored cap are untouched. Only settings.billing.hard_cap_usd_cents
-- changes; the rest of settings is preserved by jsonb_set.
--
-- "workspaces" is not on the hot tables list in MIGRATIONS.md and the
-- statement is bounded by its WHERE, so a plain UPDATE is correct.
--
-- Down: drizzle/down/0084_pro_stored_cap_4900_down.sql.
UPDATE "workspaces"
SET "settings" = jsonb_set("settings", '{billing,hard_cap_usd_cents}', '4900'::jsonb)
WHERE "settings" -> 'billing' ->> 'plan' = 'pro'
	AND "settings" -> 'billing' ->> 'hard_cap_usd_cents' = '2000';
