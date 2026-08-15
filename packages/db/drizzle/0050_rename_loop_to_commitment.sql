-- T2 of bet/loops-first-class: rename the legacy `loop` object type to
-- `commitment` so the `loop` name is free for the new pipeline concept
-- introduced by this bet (a persistent multi-agent process wrapping triggers
-- + agents + a pipeline of object states).
--
-- The old `loop` type modelled "standing commitments graduated from succeeded
-- bets" with statuses holding / at-risk / breached and metadata fields floor
-- / cadence / source_bet_id / last_breach_at. That concept is preserved
-- verbatim under the new type name; the code paths that consumed it
-- (workspace-briefing composer, subscriptions unread-feed) now filter on
-- `type='commitment'` and read from COMMITMENT_ATTENTION_STATUSES /
-- COMMITMENT_STATUS_PRIORITY. See:
--   packages/shared/src/schemas/objects.ts
--   apps/dev/src/services/workspace-briefing.ts
--   apps/dev/src/routes/subscriptions.ts
--   extensions/work/server/index.ts
--
-- Rows migrated:
--   - objects.type='loop' → 'commitment'
--   - events.entity_type='loop' → 'commitment' (audit + real-time feed)
--
-- Prod check at time of write: `list_objects(type='loop')` returned 0 rows
-- in the primary workspace and seed.ts has no `type: 'loop'` inserts, so
-- this migration is expected to be a no-op on current data. It still runs
-- to catch any dev/staging workspace that seeded the old type by hand.
--
-- Idempotent: reruns update zero rows because the WHERE clause requires
-- the pre-rename value, which the first run flips.

DO $$
DECLARE
	renamed_objects int;
	renamed_events int;
BEGIN
	WITH updated AS (
		UPDATE objects
		SET type = 'commitment',
			updated_at = now()
		WHERE type = 'loop'
		RETURNING id
	)
	SELECT count(*) INTO renamed_objects FROM updated;

	WITH updated_events AS (
		UPDATE events
		SET entity_type = 'commitment'
		WHERE entity_type = 'loop'
		RETURNING id
	)
	SELECT count(*) INTO renamed_events FROM updated_events;

	RAISE NOTICE 'migration 0050: renamed % object row(s) and % event row(s) from loop to commitment',
		renamed_objects, renamed_events;
END $$;
