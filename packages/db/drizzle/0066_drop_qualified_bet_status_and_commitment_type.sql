-- Retire two concepts that were added by mistake and never earned their place:
--
--   1. `qualified` as a **bet** status. It was never in the code's default bet
--      list (`packages/shared/src/schemas/workspaces.ts`, `extensions/work/*`),
--      which has always been
--      signal | define | active | live | succeeded | failed | paused | archived.
--      It only ever existed as stored `settings.statuses.bet` data on a handful
--      of workspaces, so this migration is the only way to remove it.
--
--   2. The `commitment` object type — the "standing commitment graduated from a
--      succeeded bet" concept (statuses holding | at-risk | breached, metadata
--      floor / cadence / source_bet_id / last_breach_at). Introduced as `loop`,
--      renamed to `commitment` by `0050_rename_loop_to_commitment.sql`, and now
--      removed outright along with every code path that consumed it (work
--      extension registration, workspace-briefing composer section, the
--      Strategist's graduation skill, the Daily Commitment Health Scan trigger,
--      and the frontend CommitmentCard).
--
-- IMPORTANT — what this migration deliberately does NOT touch:
--   * `qualified` on any type other than `bet`. It is a legitimate CRM stage on
--     `company` (e.g. the Growth workspace's
--     identified | qualified | engaged | ...) and must survive untouched. Every
--     status statement below is scoped to the `bet` key only.
--   * The Strategist's "Commitment gate" — a bet-readiness checklist run at
--     `→ active`. Unrelated to the object type despite the shared word.
--   * `commitment` object ROWS. None exist (verified across all workspaces
--     before writing this), but a migration must not silently delete user data
--     on some other deployment. Any survivors are reported via RAISE NOTICE so
--     an operator can migrate them deliberately with
--     `POST /api/objects/migrate-type`.
--
-- Idempotent: every statement's WHERE clause requires the pre-migration shape,
-- which the first run removes, so reruns update zero rows.

DO $$
DECLARE
	requalified_bets int;
	stripped_qualified int;
	stripped_statuses int;
	stripped_names int;
	stripped_fields int;
	orphan_commitments int;
BEGIN
	-- 1. Rehome bets parked in `qualified` before the status disappears from
	--    their workspace settings, so no bet is left pointing at a status the
	--    workspace no longer offers. `signal` is the correct landing spot:
	--    `qualified` sat between `signal` and `define`, and a bet that never
	--    reached `define` has not been shaped yet.
	WITH updated AS (
		UPDATE objects
		SET status = 'signal',
			updated_at = now()
		WHERE type = 'bet'
			AND status = 'qualified'
		RETURNING id, workspace_id, created_by
	),
	-- Audit + real-time feed row per mutation, per the events contract in
	-- CLAUDE.md ("Events logged on every mutation"). Written from the same CTE
	-- as the UPDATE so it targets exactly the rows this migration moved.
	logged AS (
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		SELECT u.workspace_id,
			u.created_by,
			'updated',
			'bet',
			u.id,
			jsonb_build_object(
				'changes', jsonb_build_array(
					jsonb_build_object('field', 'status', 'old', 'qualified', 'new', 'signal')
				),
				'reason', 'migration 0066: retired the qualified bet status'
			)
		FROM updated u
		RETURNING id
	)
	SELECT count(*) INTO requalified_bets FROM updated;

	-- 2. Drop `qualified` from settings.statuses.bet — bet key only.
	WITH updated AS (
		UPDATE workspaces
		SET settings = jsonb_set(
				settings,
				'{statuses,bet}',
				(
					SELECT coalesce(jsonb_agg(s), '[]'::jsonb)
					FROM jsonb_array_elements(settings->'statuses'->'bet') AS s
					WHERE s <> '"qualified"'::jsonb
				)
			)
		WHERE settings->'statuses'->'bet' @> '["qualified"]'::jsonb
		RETURNING id
	)
	SELECT count(*) INTO stripped_qualified FROM updated;

	-- 3. Drop the commitment type from statuses / display_names / field_definitions.
	WITH updated AS (
		UPDATE workspaces
		SET settings = jsonb_set(
				settings,
				'{statuses}',
				(settings->'statuses') - 'commitment'
			)
		WHERE settings->'statuses' ? 'commitment'
		RETURNING id
	)
	SELECT count(*) INTO stripped_statuses FROM updated;

	WITH updated AS (
		UPDATE workspaces
		SET settings = jsonb_set(
				settings,
				'{display_names}',
				(settings->'display_names') - 'commitment'
			)
		WHERE settings->'display_names' ? 'commitment'
		RETURNING id
	)
	SELECT count(*) INTO stripped_names FROM updated;

	WITH updated AS (
		UPDATE workspaces
		SET settings = jsonb_set(
				settings,
				'{field_definitions}',
				(settings->'field_definitions') - 'commitment'
			)
		WHERE settings->'field_definitions' ? 'commitment'
		RETURNING id
	)
	SELECT count(*) INTO stripped_fields FROM updated;

	-- 4. Report, never delete.
	SELECT count(*) INTO orphan_commitments FROM objects WHERE type = 'commitment';
	IF orphan_commitments > 0 THEN
		RAISE NOTICE 'migration 0066: % object row(s) still carry type=commitment. They were left in place — migrate or delete them deliberately via POST /api/objects/migrate-type.',
			orphan_commitments;
	END IF;

	RAISE NOTICE 'migration 0066: moved % bet(s) qualified->signal; dropped qualified from % bet status list(s); stripped commitment from % statuses, % display_names, % field_definitions map(s)',
		requalified_bets, stripped_qualified, stripped_statuses, stripped_names, stripped_fields;
END $$;
