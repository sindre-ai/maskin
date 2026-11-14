-- Rollback for 0153_trial_fresh_billing_period.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Removes the billing key from workspaces whose billing holds only what that migration wrote
-- (plan 'trial' and a period_start) and whose period_start is from the deploy day. Set the date
-- below to the deploy day (UTC) before running. A workspace that has since changed its billing
-- (a card, a plan, a cap) has more keys and is left alone.
-- The usage of those workspaces goes back to counting from their first session.
UPDATE "workspaces"
SET "settings" = "settings" - 'billing', "updated_at" = now()
WHERE "settings" -> 'billing' ?& ARRAY['plan', 'period_start']
	AND (SELECT count(*) FROM jsonb_object_keys("settings" -> 'billing')) = 2
	AND "settings" -> 'billing' ->> 'plan' = 'trial'
	AND to_timestamp(("settings" -> 'billing' ->> 'period_start')::bigint)::date = DATE '2026-11-14';
