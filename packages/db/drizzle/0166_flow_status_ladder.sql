-- One ladder of flow statuses: draft, pilot, supervised, live, paused, archived.
--
-- The shared schema and the work extension said draft, paused, learning, supervised,
-- fully_autonomous. The MCP tools said draft, pilot, supervised, live, paused, archived. The
-- MCP names win, so stored values move over, and a draft flow now has its triggers switched off
-- (apps/dev/src/lib/object-update.ts), so a draft flow that is still running has to move first.
--
--   1. A flow in draft that has at least one enabled trigger is running today (until now only
--      paused switched triggers off). It moves to supervised, so it keeps running and does not
--      stop by surprise. The tester-visible trigger state is not touched.
--   2. learning moves to pilot and fully_autonomous moves to live. Same rung, new name.
--   3. workspaces.settings.statuses.loop is rewritten to the new list where it still holds an old
--      name, so PATCH /api/objects/:id accepts the new statuses.
--
-- A flow stored as pilot, live or archived (the MCP tools could write them where the workspace
-- list allowed it) already has the right name and is left alone. It used to be shown as draft by
-- GET /api/loops; it now shows as itself.
--
-- Every moved flow gets an events row, and updated_at is left alone (a rename is not an edit).
-- The notice at the end says how many flows moved in each step.
--
-- Idempotent: each WHERE clause needs the pre-migration value, which the first run removes.
-- Down: drizzle/down/0166_flow_status_ladder_down.sql.

DO $$
DECLARE
	moved_draft int;
	moved_learning int;
	moved_autonomous int;
	updated_workspaces int;
BEGIN
	-- 1. Draft flows with enabled triggers keep running.
	WITH updated AS (
		UPDATE objects o
		SET status = 'supervised'
		WHERE o.type = 'loop'
			AND o.status = 'draft'
			AND jsonb_typeof(o.metadata->'trigger_ids') = 'array'
			AND EXISTS (
				SELECT 1
				FROM triggers t
				WHERE t.workspace_id = o.workspace_id
					AND t.enabled
					AND o.metadata->'trigger_ids' @> to_jsonb(t.id::text)
			)
		RETURNING o.id, o.workspace_id, o.created_by
	),
	logged AS (
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		SELECT u.workspace_id, u.created_by, 'updated', 'loop', u.id,
			jsonb_build_object(
				'changes', jsonb_build_array(
					jsonb_build_object('field', 'status', 'old', 'draft', 'new', 'supervised')
				),
				'reason', 'migration 0166: a draft flow with enabled triggers keeps running, draft now turns triggers off'
			)
		FROM updated u
		RETURNING id
	)
	SELECT count(*) INTO moved_draft FROM updated;

	-- 2a. learning -> pilot
	WITH updated AS (
		UPDATE objects
		SET status = 'pilot'
		WHERE type = 'loop' AND status = 'learning'
		RETURNING id, workspace_id, created_by
	),
	logged AS (
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		SELECT u.workspace_id, u.created_by, 'updated', 'loop', u.id,
			jsonb_build_object(
				'changes', jsonb_build_array(
					jsonb_build_object('field', 'status', 'old', 'learning', 'new', 'pilot')
				),
				'reason', 'migration 0166: renamed the learning flow status to pilot'
			)
		FROM updated u
		RETURNING id
	)
	SELECT count(*) INTO moved_learning FROM updated;

	-- 2b. fully_autonomous -> live
	WITH updated AS (
		UPDATE objects
		SET status = 'live'
		WHERE type = 'loop' AND status = 'fully_autonomous'
		RETURNING id, workspace_id, created_by
	),
	logged AS (
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		SELECT u.workspace_id, u.created_by, 'updated', 'loop', u.id,
			jsonb_build_object(
				'changes', jsonb_build_array(
					jsonb_build_object('field', 'status', 'old', 'fully_autonomous', 'new', 'live')
				),
				'reason', 'migration 0166: renamed the fully_autonomous flow status to live'
			)
		FROM updated u
		RETURNING id
	)
	SELECT count(*) INTO moved_autonomous FROM updated;

	-- 3. The per-workspace list of allowed flow statuses.
	WITH updated AS (
		UPDATE workspaces
		SET settings = jsonb_set(
			settings,
			'{statuses,loop}',
			'["draft","pilot","supervised","live","paused","archived"]'::jsonb
		)
		WHERE jsonb_typeof(settings->'statuses'->'loop') = 'array'
			AND (
				settings->'statuses'->'loop' @> '["learning"]'::jsonb
				OR settings->'statuses'->'loop' @> '["fully_autonomous"]'::jsonb
			)
		RETURNING id
	)
	SELECT count(*) INTO updated_workspaces FROM updated;

	RAISE NOTICE 'migration 0166: flow statuses: % draft flow(s) with enabled triggers moved to supervised, % learning to pilot, % fully_autonomous to live, % workspace status list(s) rewritten',
		moved_draft, moved_learning, moved_autonomous, updated_workspaces;
END $$;
