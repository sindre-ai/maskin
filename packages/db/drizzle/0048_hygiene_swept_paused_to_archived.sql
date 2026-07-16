-- T7 of `bet/archived-status`: rehome bets the workspace-hygiene sweep already
-- moved into `paused` as an interim shelf. Until T2 landed, Sweep A had nowhere
-- semantically correct to send council-parked bets — the bet schema had no
-- `archived` status — so it stashed them in `paused` and stamped
-- `metadata.hygiene_swept_at`. Now that `archived` exists, migrate those stamped
-- rows to their real home so `paused` recovers its "revivable-on-hold" meaning.
--
-- Preserved: bets carrying `metadata.parked_reason` stay `paused`. That field
-- signals an intentional human hold (e.g. SOC 2 Type II-style pauses waiting
-- on an external gate), not a hygiene sweep — those bets are on-hold, not done.
--
-- Idempotent: reruns update zero rows because the WHERE clause requires
-- status='paused', which the first run flips to 'archived'.

DO $$
DECLARE
	moved_ids uuid[];
	moved_count int;
BEGIN
	WITH updated AS (
		UPDATE objects
		SET status = 'archived',
			updated_at = now()
		WHERE type = 'bet'
			AND status = 'paused'
			AND metadata->>'hygiene_swept_at' IS NOT NULL
			AND metadata->>'parked_reason' IS NULL
		RETURNING id
	)
	SELECT coalesce(array_agg(id ORDER BY id), '{}'::uuid[]) INTO moved_ids FROM updated;

	moved_count := coalesce(array_length(moved_ids, 1), 0);
	RAISE NOTICE 'migration 0048: moved % hygiene-swept bet(s) from paused to archived', moved_count;
	IF moved_count > 0 THEN
		RAISE NOTICE 'migration 0048: sample ids (up to 20) — %',
			moved_ids[1:least(moved_count, 20)];
	END IF;
END $$;
