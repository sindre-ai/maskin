-- T2 of `bet/archived-status`: extend every existing workspace's bet enum with
-- `archived` and register the accompanying `archive_reason` field so hygiene
-- sweeps and the archive-flow UI have a place to record why a bet was archived.
-- Product default lives in `packages/shared/src/schemas/workspaces.ts`; this
-- migration brings pre-existing rows in line. Idempotent — reruns are no-ops.

-- 1. Ensure the containers exist so downstream jsonb_set can reach the leaves.
--    A no-op for the common case where the workspace was created via the Zod
--    schema (both keys default to non-null values), but defensive against any
--    older or externally-inserted row missing them. Only touches rows whose
--    settings is null or a jsonb object; a scalar/array settings value is left
--    alone here and skipped by steps 2/3 via their jsonb_typeof guards, so the
--    migration never raises "cannot set path in scalar".
UPDATE workspaces
SET settings = jsonb_set(
	jsonb_set(
		COALESCE(settings, '{}'::jsonb),
		'{statuses}',
		COALESCE(settings->'statuses', '{}'::jsonb),
		true
	),
	'{field_definitions}',
	COALESCE(settings->'field_definitions', '{}'::jsonb),
	true
)
WHERE settings IS NULL
	OR (
		jsonb_typeof(settings) = 'object'
		AND (settings->'statuses' IS NULL OR settings->'field_definitions' IS NULL)
	);

-- 2. Append 'archived' to statuses.bet where not already present. The
--    jsonb_typeof guard skips workspaces whose statuses value is a scalar or
--    array — those shapes can't accept jsonb_set on a nested path without
--    raising, so they're left alone here rather than crashing the migration.
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{statuses,bet}',
	COALESCE(settings->'statuses'->'bet', '[]'::jsonb) || '"archived"'::jsonb,
	true
)
WHERE jsonb_typeof(settings->'statuses') = 'object'
	AND NOT COALESCE(settings->'statuses'->'bet' @> '"archived"'::jsonb, false);

-- 3. Append archive_reason to field_definitions.bet where not already present.
--    Same jsonb_typeof guard as step 2, for the same reason.
UPDATE workspaces
SET settings = jsonb_set(
	settings,
	'{field_definitions,bet}',
	COALESCE(settings->'field_definitions'->'bet', '[]'::jsonb)
		|| '[{"name": "archive_reason", "type": "text", "required": false}]'::jsonb,
	true
)
WHERE jsonb_typeof(settings->'field_definitions') = 'object'
	AND NOT EXISTS (
		SELECT 1
		FROM jsonb_array_elements(COALESCE(settings->'field_definitions'->'bet', '[]'::jsonb)) AS elem
		WHERE elem->>'name' = 'archive_reason'
	);
