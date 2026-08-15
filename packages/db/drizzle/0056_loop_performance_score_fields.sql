-- T3 of bet/loop-lifecycle-status-ladder: lift loop performance-score fields
-- out of `objects.metadata` and onto first-class columns on the shared
-- `objects` table. The AC on the parent bet is explicit that these are
-- first-class fields, not metadata. T5's `readLoopState` reads
-- performance_score / kill_threshold / promotion_mode from metadata today —
-- this migration + the corresponding service edit are the promised lift.
--
-- Columns (all nullable — only loop-type rows populate them):
--   outcome_metric      text          — the end-state status a member object
--                                       must reach to count toward the score
--                                       (e.g. 'meeting_booked', 'actioned').
--   outcome_target      numeric       — desired outcome rate (0–100),
--                                       operator-defined, informational for
--                                       the UI; the promotion ladder itself
--                                       uses LOOP_PROMOTION_THRESHOLDS.
--   kill_threshold      numeric       — auto-demote below this. Read by
--                                       evaluateDemotion.
--   performance_score   numeric       — 0–100, computed & rewritten in place
--                                       after every run by loop-scoring.
--   promotion_mode      text          — 'auto' | 'human_approved'. Read by
--                                       evaluatePromotion.
--
-- Backfill: any existing loop row with these keys in metadata gets its
-- metadata copied to the new column, then the key is stripped from metadata.
-- Objects is not on the hot-tables list (packages/db/MIGRATIONS.md), so a
-- plain ALTER + UPDATE is fine — the table holds tens of thousands of rows
-- across dev/prod and the backfill only touches loop rows.

ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "outcome_metric" text;
--> statement-breakpoint

ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "outcome_target" numeric;
--> statement-breakpoint

ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "kill_threshold" numeric;
--> statement-breakpoint

ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "performance_score" numeric;
--> statement-breakpoint

ALTER TABLE "objects" ADD COLUMN IF NOT EXISTS "promotion_mode" text;
--> statement-breakpoint

-- Backfill any existing loop rows carrying these keys in metadata. Guarded
-- on `type = 'loop'` so non-loop rows are never touched; guarded on
-- `metadata ? 'key'` so a row without the key is not rewritten. The score
-- and thresholds cast via ->>'x' + ::numeric — invalid values are left NULL
-- rather than aborting the migration (a hand-edited metadata bag must not
-- brick the migrator). NULL-safe: `metadata ? 'x'` returns false on NULL
-- metadata, so we don't need an extra IS NOT NULL guard.
UPDATE "objects" SET "outcome_metric" = "metadata"->>'outcome_metric'
	WHERE "type" = 'loop'
		AND "metadata" ? 'outcome_metric'
		AND "outcome_metric" IS NULL;
--> statement-breakpoint

UPDATE "objects" SET "outcome_target" = ("metadata"->>'outcome_target')::numeric
	WHERE "type" = 'loop'
		AND "metadata" ? 'outcome_target'
		AND jsonb_typeof("metadata"->'outcome_target') = 'number'
		AND "outcome_target" IS NULL;
--> statement-breakpoint

UPDATE "objects" SET "kill_threshold" = ("metadata"->>'kill_threshold')::numeric
	WHERE "type" = 'loop'
		AND "metadata" ? 'kill_threshold'
		AND jsonb_typeof("metadata"->'kill_threshold') = 'number'
		AND "kill_threshold" IS NULL;
--> statement-breakpoint

UPDATE "objects" SET "performance_score" = ("metadata"->>'performance_score')::numeric
	WHERE "type" = 'loop'
		AND "metadata" ? 'performance_score'
		AND jsonb_typeof("metadata"->'performance_score') = 'number'
		AND "performance_score" IS NULL;
--> statement-breakpoint

UPDATE "objects" SET "promotion_mode" = "metadata"->>'promotion_mode'
	WHERE "type" = 'loop'
		AND "metadata" ? 'promotion_mode'
		AND "metadata"->>'promotion_mode' IN ('auto', 'human_approved')
		AND "promotion_mode" IS NULL;
--> statement-breakpoint

-- Strip the lifted keys from metadata so no consumer accidentally reads a
-- stale value. Everything else in the jsonb bag stays put (trigger_ids,
-- closed_statuses, entry_condition, etc. — all still metadata by design).
UPDATE "objects" SET "metadata" =
	"metadata"
		- 'outcome_metric'
		- 'outcome_target'
		- 'kill_threshold'
		- 'performance_score'
		- 'promotion_mode'
	WHERE "type" = 'loop'
		AND "metadata" IS NOT NULL
		AND (
			"metadata" ? 'outcome_metric'
			OR "metadata" ? 'outcome_target'
			OR "metadata" ? 'kill_threshold'
			OR "metadata" ? 'performance_score'
			OR "metadata" ? 'promotion_mode'
		);
--> statement-breakpoint

-- Domain check on promotion_mode. NULL is allowed (only loop rows populate
-- it; every non-loop row is NULL by definition). Existing production data
-- was backfilled above with the same allow-list, so this can't reject a
-- pre-existing row.
ALTER TABLE "objects" ADD CONSTRAINT "objects_promotion_mode_check"
	CHECK ("promotion_mode" IS NULL OR "promotion_mode" IN ('auto', 'human_approved'));
