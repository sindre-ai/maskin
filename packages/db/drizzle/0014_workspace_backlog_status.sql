-- Migration: ensure existing workspaces have `backlog` in settings.statuses.task
--
-- PR #362 (bet/work-kanban Task 2) added `backlog` to the workspace-settings
-- default and to all three workspace templates. Defaults only apply to
-- newly-created workspaces, so existing workspaces' persisted
-- settings.statuses.task arrays still lack `backlog` — the Backlog column on
-- /<workspaceId>/work would not render for them.
--
-- This migration prepends `backlog` to the persisted array on every workspace
-- that has a task-status array which doesn't already contain it. Workspaces
-- whose settings have no task-status array are left untouched: the runtime
-- Zod default supplies the new array (with `backlog`) on parse.
--
-- Idempotent — safe to re-run.

UPDATE workspaces
SET
	settings = jsonb_set(
		settings,
		'{statuses,task}',
		jsonb_build_array('backlog') || (settings #> '{statuses,task}'),
		false
	),
	updated_at = now()
WHERE jsonb_typeof(settings #> '{statuses,task}') = 'array'
	AND NOT ((settings #> '{statuses,task}') ? 'backlog');
