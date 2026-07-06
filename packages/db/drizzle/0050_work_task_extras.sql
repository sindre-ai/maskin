-- Promotes task metadata (decision routing, exploration phase, exploration
-- candidacy, explored bet id) from opaque JSONB into first-class columns on a
-- new work-extension-owned table. Sits 1:1 with `objects` rows where
-- type='task', keyed on `object_id` (PK + FK ON DELETE CASCADE). `objects.metadata`
-- is left intact — this is COPY, not MOVE. Table exists in every workspace but
-- stays empty when the work extension is disabled, so the base-schema E2E path
-- is unaffected.
--
-- Rollback: see packages/db/rollbacks/0050_work_task_extras.sql.

CREATE TABLE IF NOT EXISTS "work_task_extras" (
	"object_id" uuid PRIMARY KEY REFERENCES "objects"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL,
	"decision_type" text,
	"explore_phase" text,
	"explore_candidate" boolean,
	"explore_bet_id" uuid,
	CONSTRAINT "work_task_extras_decision_type_ck"
		CHECK ("decision_type" IN ('architecture','ux','copy','pricing')),
	CONSTRAINT "work_task_extras_explore_phase_ck"
		CHECK ("explore_phase" IN ('root_cause','solution','decomposition'))
);

-- One partial index per promoted filter target, keyed on (workspace_id, <field>).
-- WHERE <field> IS NOT NULL so sparse rows don't bloat the index — most tasks
-- won't have every field set.
CREATE INDEX IF NOT EXISTS "work_task_extras_ws_decision_type_idx"
	ON "work_task_extras" ("workspace_id", "decision_type")
	WHERE "decision_type" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_task_extras_ws_explore_phase_idx"
	ON "work_task_extras" ("workspace_id", "explore_phase")
	WHERE "explore_phase" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_task_extras_ws_explore_candidate_idx"
	ON "work_task_extras" ("workspace_id", "explore_candidate")
	WHERE "explore_candidate" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "work_task_extras_ws_explore_bet_id_idx"
	ON "work_task_extras" ("workspace_id", "explore_bet_id")
	WHERE "explore_bet_id" IS NOT NULL;

-- Backfill from existing task rows. COPY not MOVE — objects.metadata keys stay
-- intact so any lingering reader keeps working. Every task gets a row so future
-- filter queries can `LEFT JOIN work_task_extras` and read the promoted columns
-- directly (all nullable — only whatever agents happened to write is carried
-- across). Out-of-enum values fall back to NULL. Non-uuid text for
-- explore_bet_id and non-bool text for explore_candidate also coalesce to NULL
-- rather than tripping a cast error.
INSERT INTO "work_task_extras" (
	"object_id",
	"workspace_id",
	"decision_type",
	"explore_phase",
	"explore_candidate",
	"explore_bet_id"
)
SELECT
	o.id,
	o.workspace_id,
	CASE
		WHEN (o.metadata->>'decision_type') IN ('architecture','ux','copy','pricing')
		THEN o.metadata->>'decision_type'
	END,
	CASE
		WHEN (o.metadata->>'explore_phase') IN ('root_cause','solution','decomposition')
		THEN o.metadata->>'explore_phase'
	END,
	CASE
		WHEN (o.metadata->>'explore_candidate') IN ('true','false')
		THEN (o.metadata->>'explore_candidate')::boolean
	END,
	CASE
		WHEN (o.metadata->>'explore_bet_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
		THEN (o.metadata->>'explore_bet_id')::uuid
	END
FROM "objects" o
WHERE o.type = 'task'
ON CONFLICT ("object_id") DO NOTHING;
