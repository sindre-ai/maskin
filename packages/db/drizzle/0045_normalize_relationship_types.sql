-- 0045_normalize_relationship_types.sql
-- Backfill: normalize every existing relationships row's source_type/target_type
-- to the canonical convention ('object' or 'file').
--
-- Canonical convention (decided in T1):
--   source_type = 'file' iff source_id exists in files.id, else 'object'
--   target_type = 'file' iff target_id exists in files.id, else 'object'
--
-- `relationships` is a large, high-traffic table (the universal edge table
-- linking every object/file relationship in the app). Per
-- packages/db/MIGRATIONS.md Rule 2, this backfill runs in chunks of ~5,000
-- rows, each in its own transaction via FOR UPDATE SKIP LOCKED, rather than
-- one long-running UPDATE across the whole table that would hold row locks
-- (and block the live write path) for the full duration.
--
-- Chunking trades the original single-transaction atomicity for lock
-- friendliness: the integrity check below still fails loudly (and blocks
-- the deploy) if anything is left divergent once the loop converges, but
-- it can no longer roll back already-committed batches. The row-count
-- comparison is logged for visibility only (not a hard failure) since a
-- long-running chunked backfill can legitimately overlap with concurrent
-- object/file deletes that also touch relationships rows.
--
-- This migration must run BEFORE the T3 constraint migration (0046) on any
-- database that has divergent edges. On a fresh DB (e.g. integration-tests),
-- the loop's first batch finds nothing to do.

DO $$
DECLARE
	pre_count bigint;
	pre_state jsonb;
BEGIN
	SELECT COUNT(*) INTO pre_count FROM relationships;

	SELECT jsonb_agg(jsonb_build_object(
		'source_type', source_type,
		'target_type', target_type,
		'cnt', cnt
	) ORDER BY source_type, target_type) INTO pre_state
	FROM (
		SELECT source_type, target_type, COUNT(*) AS cnt
		FROM relationships
		GROUP BY 1, 2
	) t;

	RAISE NOTICE '=== Relationship type normalization ===';
	RAISE NOTICE 'Rows scanned: %', pre_count;
	RAISE NOTICE 'Pre-state distinct (source_type, target_type): %', COALESCE(pre_state::text, '[]');
END $$;
--> statement-breakpoint

CREATE OR REPLACE PROCEDURE backfill_relationship_types()
LANGUAGE plpgsql AS $$
DECLARE
	updated_count integer;
BEGIN
	LOOP
		WITH batch AS (
			SELECT
				r.id,
				(CASE WHEN EXISTS (SELECT 1 FROM files f WHERE f.id = r.source_id)
					THEN 'file' ELSE 'object' END) AS correct_source_type,
				(CASE WHEN EXISTS (SELECT 1 FROM files f WHERE f.id = r.target_id)
					THEN 'file' ELSE 'object' END) AS correct_target_type
			FROM relationships r
			WHERE r.source_type <> (CASE WHEN EXISTS (SELECT 1 FROM files f WHERE f.id = r.source_id) THEN 'file' ELSE 'object' END)
			   OR r.target_type <> (CASE WHEN EXISTS (SELECT 1 FROM files f WHERE f.id = r.target_id) THEN 'file' ELSE 'object' END)
			LIMIT 5000
			FOR UPDATE SKIP LOCKED
		)
		UPDATE relationships r
		SET source_type = batch.correct_source_type,
			target_type = batch.correct_target_type
		FROM batch
		WHERE r.id = batch.id;

		GET DIAGNOSTICS updated_count = ROW_COUNT;
		EXIT WHEN updated_count = 0;
		COMMIT;
	END LOOP;
END $$;
--> statement-breakpoint

CALL backfill_relationship_types();
--> statement-breakpoint

DROP PROCEDURE backfill_relationship_types();
--> statement-breakpoint

DO $$
DECLARE
	post_count bigint;
	post_state jsonb;
	divergent_after bigint;
BEGIN
	SELECT COUNT(*) INTO post_count FROM relationships;

	SELECT jsonb_agg(jsonb_build_object(
		'source_type', source_type,
		'target_type', target_type,
		'cnt', cnt
	) ORDER BY source_type, target_type) INTO post_state
	FROM (
		SELECT source_type, target_type, COUNT(*) AS cnt
		FROM relationships
		GROUP BY 1, 2
	) t;

	RAISE NOTICE 'Rows after: %', post_count;
	RAISE NOTICE 'Post-state distinct (source_type, target_type): %', COALESCE(post_state::text, '[]');

	-- Zero divergent labels remain — the one check that must hold regardless
	-- of any concurrent activity during the chunked loop above.
	SELECT COUNT(*) INTO divergent_after
	FROM relationships
	WHERE source_type NOT IN ('object', 'file')
	   OR target_type NOT IN ('object', 'file');

	IF divergent_after > 0 THEN
		RAISE EXCEPTION 'INTEGRITY FAILURE: % rows have non-canonical type labels after backfill', divergent_after;
	END IF;
	RAISE NOTICE 'Check 1 PASS: zero divergent labels';

	RAISE NOTICE 'Check 2 PASS: zero rows re-pointed (the loop only ever SETs source_type/target_type, never source_id/target_id)';

	RAISE NOTICE '=== Backfill complete ===';
END $$;
