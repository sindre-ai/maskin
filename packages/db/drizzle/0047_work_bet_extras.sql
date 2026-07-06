-- Promotes bet metadata (promotion mode, review cadence, evidence quality,
-- feedback source, merge-block status) from opaque JSONB into first-class
-- columns on a new extension-owned table. Sits 1:1 with `objects` rows where
-- type='bet', keyed on `object_id` (PK + FK ON DELETE CASCADE). `objects.metadata`
-- is left intact — this is COPY, not MOVE. Table exists in every workspace but
-- stays empty when the work extension is disabled, so the base-schema E2E path
-- is unaffected.
--
-- Rollback: see packages/db/rollbacks/0047_work_bet_extras.sql.

CREATE TABLE IF NOT EXISTS "work_bet_extras" (
	"object_id" uuid PRIMARY KEY REFERENCES "objects"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL,
	"promotion_mode" text,
	"review_date" date,
	"evidence_quality" text,
	"feedback_source" text,
	"merge_blocked" boolean,
	"merge_blocked_since" date,
	CONSTRAINT "work_bet_extras_promotion_mode_ck"
		CHECK ("promotion_mode" IN ('auto','human_approved')),
	CONSTRAINT "work_bet_extras_evidence_quality_ck"
		CHECK ("evidence_quality" IN ('gut_feeling','evidence_backed')),
	CONSTRAINT "work_bet_extras_feedback_source_ck"
		CHECK ("feedback_source" IN ('slack','email','meeting','manual','other'))
);

-- One partial index per promoted filter target, keyed on (workspace_id, <field>).
-- WHERE <field> IS NOT NULL so sparse rows don't bloat the index — most bets
-- won't have every field set.
CREATE INDEX IF NOT EXISTS "work_bet_extras_ws_promotion_mode_idx"
	ON "work_bet_extras" ("workspace_id", "promotion_mode")
	WHERE "promotion_mode" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_bet_extras_ws_review_date_idx"
	ON "work_bet_extras" ("workspace_id", "review_date")
	WHERE "review_date" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_bet_extras_ws_evidence_quality_idx"
	ON "work_bet_extras" ("workspace_id", "evidence_quality")
	WHERE "evidence_quality" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_bet_extras_ws_feedback_source_idx"
	ON "work_bet_extras" ("workspace_id", "feedback_source")
	WHERE "feedback_source" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_bet_extras_ws_merge_blocked_idx"
	ON "work_bet_extras" ("workspace_id", "merge_blocked")
	WHERE "merge_blocked" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_bet_extras_ws_merge_blocked_since_idx"
	ON "work_bet_extras" ("workspace_id", "merge_blocked_since")
	WHERE "merge_blocked_since" IS NOT NULL;

-- Backfill from existing bet rows. COPY not MOVE — objects.metadata keys stay
-- intact so any lingering reader keeps working. Every bet gets a row so future
-- filter queries can `LEFT JOIN work_bet_extras` and read the promoted columns
-- directly (all nullable — only whatever agents happened to write is carried
-- across). Out-of-enum values fall back to safe defaults: promotion_mode /
-- evidence_quality → NULL (nullable columns), feedback_source → 'other' so
-- unknown channels don't trip the CHECK. Non-date / non-bool text is dropped
-- to NULL rather than tripping a cast error.
INSERT INTO "work_bet_extras" (
	"object_id",
	"workspace_id",
	"promotion_mode",
	"review_date",
	"evidence_quality",
	"feedback_source",
	"merge_blocked",
	"merge_blocked_since"
)
SELECT
	o.id,
	o.workspace_id,
	CASE
		WHEN (o.metadata->>'promotion_mode') IN ('auto','human_approved')
		THEN o.metadata->>'promotion_mode'
	END,
	CASE
		WHEN (o.metadata->>'review_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
		THEN (o.metadata->>'review_date')::date
	END,
	CASE
		WHEN (o.metadata->>'evidence_quality') IN ('gut_feeling','evidence_backed')
		THEN o.metadata->>'evidence_quality'
	END,
	CASE
		WHEN (o.metadata->>'feedback_source') IS NULL THEN NULL
		WHEN (o.metadata->>'feedback_source') IN ('slack','email','meeting','manual','other')
		THEN o.metadata->>'feedback_source'
		ELSE 'other'
	END,
	CASE
		WHEN (o.metadata->>'merge_blocked') IN ('true','false')
		THEN (o.metadata->>'merge_blocked')::boolean
	END,
	CASE
		WHEN (o.metadata->>'merge_blocked_since') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
		THEN (o.metadata->>'merge_blocked_since')::date
	END
FROM "objects" o
WHERE o.type = 'bet'
ON CONFLICT ("object_id") DO NOTHING;
