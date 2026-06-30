-- Backfill for PR #917: rename task status 'testing' → 'validated'.
-- The code change only updated the Zod schema default and seed data, leaving
-- existing rows in the database with the old value.

-- 1. Tasks (objects) currently sitting at status='testing'
UPDATE objects
SET status = 'validated'
WHERE type = 'task'
  AND status = 'testing';

-- 2. Workspace settings: replace 'testing' with 'validated' in the
--    statuses.task JSON array (stored as jsonb).
UPDATE workspaces
SET settings = jsonb_set(
  settings,
  '{statuses,task}',
  (
    SELECT jsonb_agg(
      CASE WHEN elem = '"testing"'::jsonb THEN '"validated"'::jsonb ELSE elem END
    )
    FROM jsonb_array_elements(settings->'statuses'->'task') AS elem
  )
)
WHERE settings->'statuses'->'task' @> '"testing"'::jsonb;

-- 3. Triggers: update event-based triggers that fire on to_status='testing'
UPDATE triggers
SET config = jsonb_set(config, '{to_status}', '"validated"')
WHERE config->>'to_status' = 'testing';
