-- Backfill subscriptions + read_state for activity from the last 14 days.
--
-- Subscriptions auto-attach on object creation ('author') and on comment
-- ('commenter'), but only for activity that happened after PR #422. Anything
-- older has no subscription row, so authors/commenters don't see their own
-- objects in the For You feed. This migration fills that gap for the trailing
-- 14-day window.
--
-- Authors are inserted before commenters so 'author' wins on conflict when a
-- user both created and commented on the same object (manual subscriptions
-- predate this migration and are likewise preserved by ON CONFLICT DO NOTHING).
--
-- read_state is pegged to the current MAX(events.id) high-water mark for every
-- subscription we insert, so historical comments are treated as already read
-- and the For You page doesn't flood on first load. Existing read_state rows
-- are left alone — they already reflect each user's actual read position.

DO $$
DECLARE
	cutoff timestamptz := now() - interval '14 days';
	high_water bigint := COALESCE((SELECT MAX(id) FROM events), 0);
BEGIN
	CREATE TEMP TABLE backfilled_subs (
		workspace_id uuid NOT NULL,
		actor_id uuid NOT NULL,
		entity_type text NOT NULL,
		entity_id uuid NOT NULL
	) ON COMMIT DROP;

	WITH ins AS (
		INSERT INTO subscriptions (workspace_id, actor_id, entity_type, entity_id, source)
		SELECT o.workspace_id, o.created_by, 'object', o.id, 'author'
		FROM objects o
		JOIN workspace_members wm
			ON wm.workspace_id = o.workspace_id AND wm.actor_id = o.created_by
		WHERE o.created_at >= cutoff
		ON CONFLICT (actor_id, entity_type, entity_id) DO NOTHING
		RETURNING workspace_id, actor_id, entity_type, entity_id
	)
	INSERT INTO backfilled_subs SELECT * FROM ins;

	WITH ins AS (
		INSERT INTO subscriptions (workspace_id, actor_id, entity_type, entity_id, source)
		SELECT DISTINCT e.workspace_id, e.actor_id, 'object', e.entity_id, 'commenter'
		FROM events e
		JOIN workspace_members wm
			ON wm.workspace_id = e.workspace_id AND wm.actor_id = e.actor_id
		WHERE e.action = 'commented'
			AND e.entity_type = 'object'
			AND e.created_at >= cutoff
		ON CONFLICT (actor_id, entity_type, entity_id) DO NOTHING
		RETURNING workspace_id, actor_id, entity_type, entity_id
	)
	INSERT INTO backfilled_subs SELECT * FROM ins;

	INSERT INTO read_state (workspace_id, actor_id, entity_type, entity_id, last_read_event_id)
	SELECT workspace_id, actor_id, entity_type, entity_id, high_water
	FROM backfilled_subs
	ON CONFLICT (actor_id, entity_type, entity_id) DO NOTHING;
END $$;
