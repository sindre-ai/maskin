-- One-off data scrub: reduce old "agent deleted" and "actor reset" events to the
-- identity-only shape the routes write today: id, type, name, is_system.
--
-- Before the fix in PR 1839, DELETE /api/actors/:id wrote the whole actor row into the
-- event (action 'deleted', entity_type 'agent'), and POST /api/actors/:id/reset wrote
-- the post-reset row (action 'reset', entity_type 'actor'). Those rows carry tools,
-- model config, memory, the system prompt and credential columns, and members and
-- agents can read them through the events API. The old shape was the same for both
-- kinds, so one filter covers both. This is the step 2 filter from
-- apps/dev/scripts/scrub-actor-event-secrets.sql, run as a migration because no agent
-- holds a write connection to the production database.
--
-- Scrubbing rows does not un-expose what they held. Anything that was ever in them
-- still counts as exposed for key rotation.
--
-- The stored keys are camelCase (isSystem) because the old routes spread the Drizzle
-- row; is_system is read from either spelling. Rows already in the identity-only shape
-- have no extra keys, so they no longer match and a rerun changes nothing.
--
-- Uses jsonb key operators only, so no value is ever selected or printed. The work is
-- bounded to rows with id up to the max id seen at the start. The block raises
-- (rolling the whole statement back) if any matching row still has extra keys
-- afterwards, or if the number of these events changed. Zero matching rows (a fresh
-- database) passes quietly.
--
-- Single DO statement, so it runs atomically in one transaction. events is not on the
-- hot-table list in MIGRATIONS.md and this touches a few dozen rows in production, so
-- the unchunked UPDATE is deliberate. events has an AFTER INSERT notify trigger only
-- (0000_setup.sql, 0006_notify_drop_data.sql), nothing fires on UPDATE.
--
-- Not reversible: the removed values are gone on purpose.
DO $$
DECLARE
	max_id bigint;
	before_n bigint;
	after_n bigint;
	left_n bigint;
BEGIN
	SELECT max(id), count(*) INTO max_id, before_n
		FROM events
		WHERE (action = 'deleted' AND entity_type = 'agent')
			OR (action = 'reset' AND entity_type = 'actor');

	UPDATE events
		SET data = jsonb_build_object(
			'id', entity_id,
			'type', data -> 'type',
			'name', data -> 'name',
			'is_system', coalesce(data -> 'isSystem', data -> 'is_system', 'false'::jsonb)
		)
		WHERE ((action = 'deleted' AND entity_type = 'agent')
				OR (action = 'reset' AND entity_type = 'actor'))
			AND id <= max_id
			AND data IS NOT NULL
			AND jsonb_typeof(data) = 'object'
			AND (data - ARRAY['id', 'type', 'name', 'is_system']) <> '{}'::jsonb;

	SELECT count(*) INTO after_n
		FROM events
		WHERE ((action = 'deleted' AND entity_type = 'agent')
				OR (action = 'reset' AND entity_type = 'actor'))
			AND id <= max_id;

	SELECT count(*) INTO left_n
		FROM events
		WHERE ((action = 'deleted' AND entity_type = 'agent')
				OR (action = 'reset' AND entity_type = 'actor'))
			AND data IS NOT NULL
			AND jsonb_typeof(data) = 'object'
			AND (data - ARRAY['id', 'type', 'name', 'is_system']) <> '{}'::jsonb;

	IF left_n <> 0 THEN
		RAISE EXCEPTION 'scrub failed: % actor deleted or reset events still hold extra keys', left_n;
	END IF;
	IF after_n <> before_n THEN
		RAISE EXCEPTION 'scrub failed: actor deleted or reset event count changed (% before, % after)', before_n, after_n;
	END IF;
END $$;
