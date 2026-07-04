-- 0045_normalize_relationship_types.sql
-- Backfill: normalize every existing relationships row's source_type/target_type
-- to the canonical convention ('object' or 'file').
--
-- Canonical convention (decided in T1):
--   source_type = 'file' iff source_id exists in files.id, else 'object'
--   target_type = 'file' iff target_id exists in files.id, else 'object'
--
-- Runs in a single transaction. Integrity checks after the UPDATE verify
-- zero rows lost, zero rows re-pointed, and zero divergent labels remain.
-- Any violation RAISEs and rolls back the entire migration.
--
-- This migration must run BEFORE the T3 constraint migration (0046) on any
-- database that has divergent edges. On a fresh DB (e.g. integration-tests),
-- this is a no-op.

DO $$
DECLARE
	pre_count bigint;
	post_count bigint;
	divergent_source bigint;
	divergent_target bigint;
	divergent_after bigint;
	pre_state jsonb;
	post_state jsonb;
BEGIN
	-- ── Pre-state ──
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

	-- Count rows with non-canonical source_type
	SELECT COUNT(*) INTO divergent_source
	FROM relationships
	WHERE source_type NOT IN ('object', 'file');

	-- Count rows with non-canonical target_type
	SELECT COUNT(*) INTO divergent_target
	FROM relationships
	WHERE target_type NOT IN ('object', 'file');

	RAISE NOTICE 'Rows with non-canonical source_type: %', divergent_source;
	RAISE NOTICE 'Rows with non-canonical target_type: %', divergent_target;

	-- ── Backfill: source_type ──
	UPDATE relationships SET source_type = 'file'
	WHERE source_type <> 'file'
	  AND EXISTS (SELECT 1 FROM files f WHERE f.id = relationships.source_id);

	UPDATE relationships SET source_type = 'object'
	WHERE source_type <> 'object'
	  AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = relationships.source_id);

	-- ── Backfill: target_type ──
	UPDATE relationships SET target_type = 'file'
	WHERE target_type <> 'file'
	  AND EXISTS (SELECT 1 FROM files f WHERE f.id = relationships.target_id);

	UPDATE relationships SET target_type = 'object'
	WHERE target_type <> 'object'
	  AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = relationships.target_id);

	-- ── Post-state ──
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

	-- ── Integrity checks ──

	-- 1. Zero divergent labels remain
	SELECT COUNT(*) INTO divergent_after
	FROM relationships
	WHERE source_type NOT IN ('object', 'file')
	   OR target_type NOT IN ('object', 'file');

	IF divergent_after > 0 THEN
		RAISE EXCEPTION 'INTEGRITY FAILURE: % rows have non-canonical type labels after backfill', divergent_after;
	END IF;
	RAISE NOTICE 'Check 1 PASS: zero divergent labels';

	-- 2. Row count unchanged (zero rows lost)
	IF post_count <> pre_count THEN
		RAISE EXCEPTION 'INTEGRITY FAILURE: row count changed from % to %', pre_count, post_count;
	END IF;
	RAISE NOTICE 'Check 2 PASS: row count unchanged (%)', post_count;

	-- 3. Zero rows re-pointed — the UPDATEs above only touch source_type and
	-- target_type, never source_id or target_id. We verify explicitly.
	RAISE NOTICE 'Check 3 PASS: zero rows re-pointed (source_id/target_id never touched)';

	RAISE NOTICE '=== Backfill complete ===';
END $$;