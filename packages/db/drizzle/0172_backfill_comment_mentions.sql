-- Fill comment_mentions (0171) from the comments written before its trigger existed.
--
-- Walks `events` by id range, 20,000 ids at a time, each chunk in its own transaction (COMMIT in a
-- procedure, packages/db/MIGRATIONS.md Rule 2), so no transaction is open for long and the
-- vacuum horizon is never held back. It only reads `events` (no row or table lock on it) and only
-- inserts into the new table, so live comment writes are never blocked. Range scans on the
-- primary key, so each chunk touches a bounded slice, not the whole table.
--
-- Safe to re-run: ON CONFLICT DO NOTHING, and a second pass adds nothing. A run stopped part-way
-- loses at most its current chunk; the next run starts from id 0 and skips what is already there.
-- Comments inserted after the walk starts have ids above `top` and are covered by the trigger from
-- 0171, which was committed before this file runs.
--
-- Same rule as the trigger (see 0171): only well-formed uuids, never the commenter themselves.
-- The procedure is dropped at the end; it has no use after the migration.
-- Down: nothing to undo here; see drizzle/down/0171_comment_mentions_down.sql.
CREATE OR REPLACE PROCEDURE backfill_comment_mentions()
LANGUAGE plpgsql AS $$
DECLARE
	lo bigint := 0;
	hi bigint;
	top bigint;
BEGIN
	SELECT coalesce(max(id), 0) INTO top FROM events;
	WHILE lo < top LOOP
		hi := lo + 20000;
		INSERT INTO comment_mentions (workspace_id, actor_id, entity_id)
		SELECT m.workspace_id, m.actor_id, m.entity_id
		FROM (
			SELECT e.workspace_id, e.entity_id, e.actor_id AS commenter_id,
				CASE
					WHEN t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t::uuid
				END AS actor_id
			FROM events e
			CROSS JOIN LATERAL jsonb_array_elements_text(
				CASE WHEN jsonb_typeof(e.data -> 'mentions') = 'array'
					THEN e.data -> 'mentions' ELSE '[]'::jsonb END
			) AS t
			WHERE e.id > lo AND e.id <= hi AND e.action = 'commented'
		) AS m
		WHERE m.actor_id IS NOT NULL AND m.actor_id <> m.commenter_id
		ON CONFLICT DO NOTHING;
		lo := hi;
		COMMIT;
	END LOOP;
END $$;
--> statement-breakpoint
CALL backfill_comment_mentions();
--> statement-breakpoint
DROP PROCEDURE backfill_comment_mentions();
