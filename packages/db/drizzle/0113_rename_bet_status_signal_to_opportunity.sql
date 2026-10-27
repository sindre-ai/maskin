-- Rename the bet status `signal` to `opportunity`, everywhere it is stored.
--
-- Changing the default list in code (`packages/shared/src/schemas/workspaces.ts`)
-- does not touch workspaces that already exist, so every place that holds the
-- old name has to be rewritten here:
--
--   1. objects            bets with status = 'signal'             (+ an events row each)
--   2. workspaces         settings.statuses.bet, and any other settings value equal to "signal"
--   3. triggers           config (from_status / to_status / status filters) and action_prompt
--   4. actors             system_prompt, description
--   5. workspace_skills   content, description
--   6. user_display_settings, marketplace_loop_items   saved filters / catalog snapshots
--
-- What this deliberately does NOT touch:
--   * Agent and trigger NAMES ("Signal Analyst", "Daily signal sweep"). Triggers and
--     prompts refer to agents by name, so renaming them is a separate change.
--   * The plain English word "signal" in prose ("filter signal from noise").
--   * Free-form user content: object bodies, comments, chat messages, session history.
--   * Agent files in S3 (skills, learnings, memory) — SQL cannot reach those.
--   * `qualified`-era history: migration 0066 still writes 'signal'. It runs before this
--     migration on a fresh database, so this one picks its output up.
--
-- Prompt text is rewritten only where `signal` is clearly the status: in backticks
-- (`signal`), as a transition (`signal → define`, `signal | define`), as **signal**,
-- as a quoted literal, after `status =` / `status:`, or as "signal-stage".
--
-- Idempotent: every statement's WHERE clause requires the pre-migration text, which
-- the first run removes, so reruns change nothing and log no events.

CREATE OR REPLACE FUNCTION rename_signal_status_text(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
	t text := input;
BEGIN
	IF t IS NULL THEN RETURN NULL; END IF;
	t := regexp_replace(t, '`signal`', '`opportunity`', 'g');
	t := regexp_replace(t, '`signal(\s*(?:→|->|\|)\s)', '`opportunity\1', 'g');
	t := regexp_replace(t, '(["''])signal\1', '\1opportunity\1', 'g');
	t := regexp_replace(t, '(\mstatus\s*[=:]\s*)signal\M', '\1opportunity', 'g');
	t := regexp_replace(t, '\*\*signal\*\*', '**opportunity**', 'g');
	t := regexp_replace(t, '\msignal-stage\M', 'opportunity-stage', 'g');
	t := regexp_replace(t, '\m(an? |existing |new |staged |legacy )signal (bets?)\M', '\1opportunity \2', 'g');
	t := regexp_replace(t, '\mSIGNAL BET SWEEP\M', 'OPPORTUNITY BET SWEEP', 'g');
	t := regexp_replace(t, '\mat signal status\M', 'at opportunity status', 'g');
	-- keep the article right where a rewrite produced "a opportunity"
	t := regexp_replace(t, '\m([Aa]) (opportunity)\M', '\1n \2', 'g');
	RETURN t;
END
$fn$;
--> statement-breakpoint

-- jsonb variant: prose rules work on the text form (backticks and arrows are not
-- escaped there; quoted literals are, so those go through the exact-value rule below).
CREATE OR REPLACE FUNCTION rename_signal_status_jsonb(input jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $fn$
	SELECT regexp_replace(
		regexp_replace(
			regexp_replace(input::text,
				'`signal`', '`opportunity`', 'g'),
			'`signal(\s*(?:→|->|\|)\s)', '`opportunity\1', 'g'),
		'(?<!\\)"signal"', '"opportunity"', 'g')::jsonb
$fn$;
--> statement-breakpoint

DO $$
DECLARE
	moved_bets int;
	updated_workspaces int;
	updated_triggers int;
	updated_actors int;
	updated_skills int;
	updated_display int;
	updated_snapshots int;
BEGIN
	-- 1. Bets. The events row comes from the same CTE as the UPDATE, so it targets
	--    exactly the rows this migration moved ("events on every mutation").
	WITH updated AS (
		UPDATE objects
		SET status = 'opportunity',
			updated_at = now()
		WHERE type = 'bet'
			AND status = 'signal'
		RETURNING id, workspace_id, created_by
	),
	logged AS (
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		SELECT u.workspace_id,
			u.created_by,
			'updated',
			'bet',
			u.id,
			jsonb_build_object(
				'changes', jsonb_build_array(
					jsonb_build_object('field', 'status', 'old', 'signal', 'new', 'opportunity')
				),
				'reason', 'migration 0113: renamed the signal bet status to opportunity'
			)
		FROM updated u
		RETURNING id
	)
	SELECT count(*) INTO moved_bets FROM updated;

	-- 2a. settings.statuses.bet: swap in place so the status keeps its position.
	--     A workspace that already lists `opportunity` just loses `signal`.
	UPDATE workspaces
	SET settings = jsonb_set(
			settings,
			'{statuses,bet}',
			(
				SELECT coalesce(jsonb_agg(v ORDER BY first_pos), '[]'::jsonb)
				FROM (
					SELECT v, min(pos) AS first_pos
					FROM (
						SELECT CASE WHEN s = '"signal"'::jsonb THEN '"opportunity"'::jsonb ELSE s END AS v, pos
						FROM jsonb_array_elements(settings->'statuses'->'bet') WITH ORDINALITY AS t(s, pos)
					) renamed
					GROUP BY v
				) deduped
			)
		)
	WHERE jsonb_typeof(settings->'statuses'->'bet') = 'array'
		AND settings->'statuses'->'bet' @> '["signal"]'::jsonb;

	-- 2b. Any other settings value that is exactly "signal" (status-keyed config).
	WITH updated AS (
		UPDATE workspaces
		SET settings = rename_signal_status_jsonb(settings)
		WHERE settings::text ~ '"signal"'
		RETURNING id
	)
	SELECT count(*) INTO updated_workspaces FROM updated;

	-- 3. Triggers: filters and prompt text.
	WITH updated AS (
		UPDATE triggers
		SET config = rename_signal_status_jsonb(config),
			action_prompt = rename_signal_status_text(action_prompt)
		WHERE config::text ~ '"signal"|`signal'
			OR action_prompt <> rename_signal_status_text(action_prompt)
		RETURNING id
	)
	SELECT count(*) INTO updated_triggers FROM updated;

	-- 4. Agent prompts.
	WITH updated AS (
		UPDATE actors
		SET system_prompt = rename_signal_status_text(system_prompt),
			description = rename_signal_status_text(description)
		WHERE system_prompt <> rename_signal_status_text(system_prompt)
			OR description <> rename_signal_status_text(description)
		RETURNING id
	)
	SELECT count(*) INTO updated_actors FROM updated;

	-- 5. Workspace skills.
	WITH updated AS (
		UPDATE workspace_skills
		SET content = rename_signal_status_text(content),
			description = rename_signal_status_text(description)
		WHERE content <> rename_signal_status_text(content)
			OR description <> rename_signal_status_text(description)
		RETURNING id
	)
	SELECT count(*) INTO updated_skills FROM updated;

	-- 6. Saved filters / view state and marketplace catalog snapshots.
	WITH updated AS (
		UPDATE user_display_settings
		SET settings = rename_signal_status_jsonb(settings)
		WHERE settings::text ~ '"signal"'
		RETURNING 1
	)
	SELECT count(*) INTO updated_display FROM updated;

	WITH updated AS (
		UPDATE marketplace_loop_items
		SET item_snapshot = rename_signal_status_jsonb(item_snapshot)
		WHERE item_snapshot::text ~ '"signal"|`signal'
		RETURNING 1
	)
	SELECT count(*) INTO updated_snapshots FROM updated;

	RAISE NOTICE 'migration 0113: signal->opportunity: % bet(s), % workspace(s), % trigger(s), % actor(s), % skill(s), % display-settings row(s), % catalog snapshot(s)',
		moved_bets, updated_workspaces, updated_triggers, updated_actors, updated_skills, updated_display, updated_snapshots;
END $$;
--> statement-breakpoint

DROP FUNCTION IF EXISTS rename_signal_status_jsonb(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS rename_signal_status_text(text);
