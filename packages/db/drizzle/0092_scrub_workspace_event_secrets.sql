-- One-off data scrub: remove llm_keys, custom_llm and claude_oauth from the
-- workspace snapshot that old "workspace updated" events carry under
-- data.updated.settings.
--
-- Before the redaction change (PR 2036) the PATCH /api/workspaces/:id handler wrote
-- the whole workspace row into the event, settings included, so those rows hold
-- credentials that members and agents can read through the events API. New rows use
-- the {changes, changed_settings_keys} shape with no updated key and cannot match.
--
-- Only the three keys are removed. Every other field and every row stays, so the
-- audit trail is intact. Other entity types are untouched. Uses jsonb key-existence
-- and the jsonb minus operator only, so no value is ever selected or printed.
--
-- The work is bounded to rows with id up to the max id seen at the start, and the
-- block raises (rolling the whole statement back) if the row count changed or if any
-- workspace updated event still carries one of the keys afterwards. Zero matching
-- rows (a fresh database) passes quietly.
--
-- Single DO statement, so it runs atomically in one transaction. events is not on the
-- hot-table list in MIGRATIONS.md and this touches roughly 400 rows in production, so
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
		WHERE entity_type = 'workspace' AND action = 'updated';

	UPDATE events
		SET data = jsonb_set(
			data,
			'{updated,settings}',
			(data->'updated'->'settings') - 'llm_keys' - 'custom_llm' - 'claude_oauth'
		)
		WHERE entity_type = 'workspace' AND action = 'updated'
			AND id <= max_id
			AND jsonb_typeof(data->'updated'->'settings') = 'object'
			AND data->'updated'->'settings' ?| array['llm_keys', 'custom_llm', 'claude_oauth'];

	SELECT count(*) INTO after_n
		FROM events
		WHERE entity_type = 'workspace' AND action = 'updated' AND id <= max_id;

	SELECT count(*) INTO left_n
		FROM events
		WHERE entity_type = 'workspace' AND action = 'updated'
			AND jsonb_typeof(data->'updated'->'settings') = 'object'
			AND data->'updated'->'settings' ?| array['llm_keys', 'custom_llm', 'claude_oauth'];

	IF left_n <> 0 THEN
		RAISE EXCEPTION 'scrub failed: % workspace updated events still carry a credential key', left_n;
	END IF;
	IF after_n <> before_n THEN
		RAISE EXCEPTION 'scrub failed: workspace updated event count changed (% before, % after)', before_n, after_n;
	END IF;
END $$;
