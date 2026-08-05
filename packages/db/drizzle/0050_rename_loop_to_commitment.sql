-- Rename the standing-commitment object type from `loop` → `commitment`.
--
-- The `loop` type was registered on 2026-07-11 for "standing commitments
-- graduated from succeeded bets" (statuses `holding` / `at-risk` /
-- `breached`; metadata `floor`, `cadence`). In the loops-first-class-type
-- bet the `loop` name is being reused for the new multi-agent pipeline
-- primitive, so the old concept is renamed to `commitment` and the `loop`
-- name is freed for the new type. Expand/contract: the new `commitment`
-- type is registered in the work extension in the same PR, so this
-- migration + code change land together and there is no window where the
-- shared briefing composer / unread-feed queries reference the old type
-- against renamed rows.
--
-- Idempotent + safe on populated workspaces:
--   1. `WHERE type = 'loop'` — a rerun updates zero rows (the first run
--      flipped them). Safe to reapply in CI or against a dev DB where
--      migrations have already run.
--   2. No `pg_notify` fires on `objects` — the NOTIFY trigger lives on
--      the `events` table (see 0006_notify_drop_data.sql). This UPDATE
--      cannot hit the 8 KB payload limit even on production-shape data.
--   3. `objects` is not on the hot-tables list in packages/db/MIGRATIONS.md,
--      so a straight UPDATE (no chunking, no CONCURRENTLY) is fine. As of
--      this writing dev workspaces have zero `type='loop'` rows, so this
--      is functionally a no-op today; the migration exists so any future
--      dev/prod DB with stragglers gets renamed atomically with the code
--      switch and doesn't force a follow-up backfill PR.

UPDATE objects SET type = 'commitment' WHERE type = 'loop';

-- Also rename the type key inside each workspace's registered statuses
-- and display_names maps. Without this, the workspace's on-disk settings
-- would still list `statuses.loop = [...standing commitment statuses]` and
-- the work extension's newly-registered `loop` (multi-agent pipeline)
-- statuses would either collide on merge or be silently ignored,
-- depending on merge order.
--
-- `?` operator is used to only touch workspaces that actually carry a
-- `loop` key today — greenfield workspaces (which will pick up the new
-- shape from the extension's defaults) stay untouched.

UPDATE workspaces
SET settings = jsonb_set(
	settings #- '{statuses,loop}',
	'{statuses,commitment}',
	settings->'statuses'->'loop'
)
WHERE settings->'statuses' ? 'loop';

UPDATE workspaces
SET settings = jsonb_set(
	settings #- '{display_names,loop}',
	'{display_names,commitment}',
	settings->'display_names'->'loop'
)
WHERE settings->'display_names' ? 'loop';

UPDATE workspaces
SET settings = jsonb_set(
	settings #- '{field_definitions,loop}',
	'{field_definitions,commitment}',
	settings->'field_definitions'->'loop'
)
WHERE settings->'field_definitions' ? 'loop';
