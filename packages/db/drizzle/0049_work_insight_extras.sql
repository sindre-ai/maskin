-- Promotes insight metadata (theme, strength, anchor, feedback_source) from
-- opaque JSONB into first-class columns on a new extension-owned table under
-- the work extension. Sits 1:1 with `objects` rows where type='insight', keyed
-- on `object_id` (PK + FK ON DELETE CASCADE). `objects.metadata` is left intact
-- — this is COPY, not MOVE. Table exists in every workspace but stays empty
-- when the work extension is disabled, so the base-schema E2E path is
-- unaffected.
--
-- Rollback: see packages/db/rollbacks/0049_work_insight_extras.sql.

CREATE TABLE IF NOT EXISTS "work_insight_extras" (
	"object_id" uuid PRIMARY KEY REFERENCES "objects"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL,
	"theme" text,
	"strength" text,
	"anchor" text,
	"feedback_source" text,
	CONSTRAINT "work_insight_extras_strength_ck"
		CHECK ("strength" IN ('weak','moderate','strong')),
	CONSTRAINT "work_insight_extras_anchor_ck"
		CHECK ("anchor" IN ('#1','#2','#3','#4','#5')),
	CONSTRAINT "work_insight_extras_feedback_source_ck"
		CHECK ("feedback_source" IN ('slack','email','meeting','manual','other'))
);

-- One partial index per promoted filter target, keyed on (workspace_id, <field>).
-- WHERE <field> IS NOT NULL so sparse rows don't bloat the index — most insights
-- won't have every field set.
CREATE INDEX IF NOT EXISTS "work_insight_extras_ws_theme_idx"
	ON "work_insight_extras" ("workspace_id", "theme")
	WHERE "theme" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_insight_extras_ws_strength_idx"
	ON "work_insight_extras" ("workspace_id", "strength")
	WHERE "strength" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_insight_extras_ws_anchor_idx"
	ON "work_insight_extras" ("workspace_id", "anchor")
	WHERE "anchor" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_insight_extras_ws_feedback_source_idx"
	ON "work_insight_extras" ("workspace_id", "feedback_source")
	WHERE "feedback_source" IS NOT NULL;

-- Backfill from existing insight rows. COPY not MOVE — objects.metadata keys
-- stay intact so any lingering reader keeps working. Every insight gets a row
-- so future filter queries can `LEFT JOIN work_insight_extras` and read the
-- promoted columns directly (all nullable — only whatever agents happened to
-- write is carried across). Out-of-enum values fall back to safe defaults:
-- strength / anchor → NULL (nullable columns), feedback_source → 'other' so
-- unknown channels don't trip the CHECK (same shape as work_bet_extras).
-- Empty theme strings collapse to NULL rather than being written literally.
INSERT INTO "work_insight_extras" (
	"object_id",
	"workspace_id",
	"theme",
	"strength",
	"anchor",
	"feedback_source"
)
SELECT
	o.id,
	o.workspace_id,
	NULLIF(o.metadata->>'theme', ''),
	CASE
		WHEN (o.metadata->>'strength') IN ('weak','moderate','strong')
		THEN o.metadata->>'strength'
	END,
	CASE
		WHEN (o.metadata->>'anchor') IN ('#1','#2','#3','#4','#5')
		THEN o.metadata->>'anchor'
	END,
	CASE
		WHEN (o.metadata->>'feedback_source') IS NULL THEN NULL
		WHEN (o.metadata->>'feedback_source') IN ('slack','email','meeting','manual','other')
		THEN o.metadata->>'feedback_source'
		ELSE 'other'
	END
FROM "objects" o
WHERE o.type = 'insight'
ON CONFLICT ("object_id") DO NOTHING;
