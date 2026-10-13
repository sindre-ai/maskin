-- Skjald outcome.created / outcome.updated used to save their meeting with
-- status 'done', which is not a valid meeting status here (scheduled, happened,
-- processed, cancelled, archived). The webhook now writes 'happened'; this moves
-- the rows it already saved.
--
-- Narrow on purpose: only the outcome path writes metadata.started_at, so
-- "started_at is present" picks outcome meetings and leaves the older
-- transcription.completed meetings (which still write 'done') alone.
--
-- Data only, no schema change. Idempotent: reruns update zero rows because the
-- WHERE clause requires status='done', which the first run flips to 'happened'.

DO $$
DECLARE
	moved_ids uuid[];
	moved_count int;
BEGIN
	WITH updated AS (
		UPDATE objects
		SET status = 'happened',
			updated_at = now()
		WHERE type = 'meeting'
			AND status = 'done'
			AND metadata->>'source' = 'skjald'
			AND metadata ? 'started_at'
		RETURNING id
	)
	SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO moved_ids FROM updated;

	moved_count := coalesce(array_length(moved_ids, 1), 0);
	RAISE NOTICE 'migration 0091: moved % Skjald outcome meeting(s) from done to happened', moved_count;
	IF moved_count > 0 THEN
		RAISE NOTICE 'migration 0091: sample ids (up to 20) — %',
			moved_ids[1:least(moved_count, 20)];
	END IF;
END $$;
