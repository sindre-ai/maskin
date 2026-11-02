-- One-off scrub: historical actor events that hold the full actor row.
--
-- Before this fix, DELETE /api/actors/:id wrote the whole actor row into the
-- events table (action 'deleted', entity_type 'agent'), and POST
-- /api/actors/:id/reset wrote the post-reset row (action 'reset',
-- entity_type 'actor'). Those rows carry tools, llm_config, memory, system
-- prompt and credential columns, and events are readable by workspace members.
--
-- This rewrites data on those rows to the same identity-only shape the routes
-- now write: id, type, name, is_system. It is NOT a drizzle migration and is
-- NOT run automatically. Infra & DevOps runs it once, after the code fix is
-- deployed (otherwise new rows keep landing in the old shape).
--
-- Scrubbing rows does not un-expose the values. Anything that was ever in
-- those rows must still be treated as exposed and rotated.
--
-- Idempotent: a scrubbed row has only the four keys, so it no longer matches.
-- The stored row keys are camelCase (isSystem) because the routes spread the
-- Drizzle row; is_system is read from either spelling.
--
-- Run with psql. Review the counts from step 1 before committing step 2.

BEGIN;

-- 1. Dry run: how many rows will change. Counts only, no data is selected.
SELECT action, entity_type, count(*) AS rows_to_scrub
FROM events
WHERE ((action = 'deleted' AND entity_type = 'agent') OR (action = 'reset' AND entity_type = 'actor'))
	AND data IS NOT NULL
	AND jsonb_typeof(data) = 'object'
	AND (data - ARRAY['id', 'type', 'name', 'is_system']) <> '{}'::jsonb
GROUP BY action, entity_type;

-- 2. Scrub.
UPDATE events
SET data = jsonb_build_object(
	'id', entity_id,
	'type', data -> 'type',
	'name', data -> 'name',
	'is_system', coalesce(data -> 'isSystem', data -> 'is_system', 'false'::jsonb)
)
WHERE ((action = 'deleted' AND entity_type = 'agent') OR (action = 'reset' AND entity_type = 'actor'))
	AND data IS NOT NULL
	AND jsonb_typeof(data) = 'object'
	AND (data - ARRAY['id', 'type', 'name', 'is_system']) <> '{}'::jsonb;

-- 3. Verify: must return 0 before you COMMIT.
SELECT count(*) AS rows_still_holding_extra_keys
FROM events
WHERE ((action = 'deleted' AND entity_type = 'agent') OR (action = 'reset' AND entity_type = 'actor'))
	AND data IS NOT NULL
	AND jsonb_typeof(data) = 'object'
	AND (data - ARRAY['id', 'type', 'name', 'is_system']) <> '{}'::jsonb;

-- COMMIT if step 3 returned 0, otherwise ROLLBACK.
-- COMMIT;
ROLLBACK;
