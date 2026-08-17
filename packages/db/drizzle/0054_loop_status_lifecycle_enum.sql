-- T2 of bet/loop-lifecycle-status-ladder: replace the legacy loop status enum
-- (running | waiting | paused | archived) with the maturity-ladder enum
-- (draft | pilot | supervised | live | paused | archived). This is the data
-- layer every downstream task in the bet reads from — T1's TriggerRunner
-- gate, T4's permissions, T5's promotion/demotion logic — so pre-existing
-- rows must not sit at a value the new enum doesn't recognise.
--
-- Product default lives in packages/shared/src/schemas/workspaces.ts and
-- packages/shared/src/schemas/objects.ts::LOOP_STATUSES. This migration
-- brings pre-existing workspace settings and existing type='loop' object
-- rows in line with that source of truth. Idempotent — reruns are no-ops.
--
-- Ordering matters: the guided-setup handshake (metadata.setup.stage='test'
-- -> pilot) runs BEFORE the legacy-status remap so a loop that carries both
-- the guided-setup marker AND an old status='running' lands at 'pilot', not
-- 'live' (the guided-setup rung is more conservative than the semantic
-- carry-over, and the brief explicitly names the handshake). The setup.stage
-- marker itself is left in place — only lifecycleState() in the future
-- guided-setup module reads it, and this migration only owns the status
-- column mapping, not the metadata schema.

-- 1. Guided-setup handshake: existing loops carrying metadata.setup.stage
--    = 'test' land at 'pilot' regardless of prior status. The path is
--    accessed through jsonb_typeof guards so a loop with a scalar/array
--    metadata (or no metadata at all) is safely skipped rather than crashing
--    the migration.
UPDATE objects
SET status = 'pilot'
WHERE type = 'loop'
	AND jsonb_typeof(metadata) = 'object'
	AND jsonb_typeof(metadata->'setup') = 'object'
	AND metadata->'setup'->>'stage' = 'test'
	AND status <> 'pilot';

-- 2. Legacy-status semantic remap: existing loops still carrying the pre-
--    ladder enum get mapped to their closest ladder rung.
--      running -> live       (both mean "firing unattended")
--      waiting -> supervised (both mean "human approval in the loop")
--    paused/archived carry over unchanged and are not touched here.
UPDATE objects
SET status = 'live'
WHERE type = 'loop' AND status = 'running';

UPDATE objects
SET status = 'supervised'
WHERE type = 'loop' AND status = 'waiting';

-- 3. Workspace settings: append every new rung to settings.statuses.loop
--    and drop the retired rungs, so create_objects/update_objects status
--    validation and the workspace schema surface stay in sync with the
--    product default. Mirrors the two-step containers-then-set pattern
--    used by 0047_bet_archived_status_and_archive_reason.sql; see that
--    migration for the reasoning behind the jsonb_typeof guards and the
--    COALESCE nesting.
UPDATE workspaces
SET settings = jsonb_set(
	COALESCE(settings, '{}'::jsonb),
	'{statuses}',
	COALESCE(settings->'statuses', '{}'::jsonb),
	true
)
WHERE settings IS NULL
	OR (
		jsonb_typeof(settings) = 'object'
		AND settings->'statuses' IS NULL
	);

-- Overwrite statuses.loop with the new ladder in a single assignment: any
-- workspace whose loop list is missing a new rung or still carries a retired
-- rung ends at the canonical value. Skips workspaces whose statuses value
-- isn't an object (scalar/array), for the same reason as 0047.
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{statuses,loop}',
	'["draft", "pilot", "supervised", "live", "paused", "archived"]'::jsonb,
	true
)
WHERE jsonb_typeof(settings->'statuses') = 'object'
	AND (
		settings->'statuses'->'loop' IS NULL
		OR settings->'statuses'->'loop' <> '["draft", "pilot", "supervised", "live", "paused", "archived"]'::jsonb
	);
