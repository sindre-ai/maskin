-- Migration: start a fresh billing period for trial workspaces that are still running, so the new
-- trial limit counts their usage from deploy time and not their all-time cost
-- (task "Reset trial usage period on deploy", bet "A card to start a 7-day trial").
-- A trial workspace with no billing block has no period_start, so its usage is summed over its whole
-- life. Some active ones are already past the new limit and would be stopped by this deploy.
-- Qualifying: enterprise_granted is false, settings has no billing block at all (missing or JSON null),
-- and at least one session was created in the last 30 days. The rule picks the workspaces; none are named.
-- Writes settings.billing = { plan: 'trial', period_start: <now, Unix SECONDS> } and leaves every
-- other settings key untouched. 'plan' is written because the strict workspace settings schema
-- requires it in a billing block (a block without it makes the whole billing block read back as
-- absent); an absent plan already counts as 'trial', so behaviour is unchanged. Same fresh-period
-- move as billingAfterCancel in apps/dev/src/lib/llm-source-mutex.ts.
-- Idempotent: a workspace that has a billing block (this migration ran, or the same change was made by
-- hand) is skipped, so a second run changes nothing. An empty database updates 0 rows.
-- Not on the hot-table list (workspaces is small and not on a webhook path), so one UPDATE is fine.
-- No triggers / pg_notify. Down: drizzle/down/0153_trial_fresh_billing_period_down.sql.

UPDATE "workspaces" w
SET
	"settings" = jsonb_set(
		w."settings",
		'{billing}',
		jsonb_build_object('plan', 'trial', 'period_start', floor(extract(epoch FROM now()))::bigint)
	),
	"updated_at" = now()
WHERE w."enterprise_granted" = false
	AND COALESCE(jsonb_typeof(w."settings" -> 'billing'), 'null') = 'null'
	AND EXISTS (
		SELECT 1
		FROM "sessions" s
		WHERE s."workspace_id" = w."id"
			AND s."created_at" >= now() - interval '30 days'
	);
