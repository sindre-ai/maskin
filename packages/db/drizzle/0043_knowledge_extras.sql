-- Promotes knowledge metadata (provenance, bi-temporal validity, confidence,
-- verification, writer-type) from opaque JSONB into first-class columns on a
-- new extension-owned table. Sits 1:1 with `objects` rows where type='knowledge',
-- keyed on `object_id` (PK + FK ON DELETE CASCADE). `objects.metadata` is left
-- intact — this is COPY, not MOVE. Table exists in every workspace but stays
-- empty when the knowledge extension is disabled, so the base-schema E2E path
-- is unaffected.
--
-- Rollback: see packages/db/rollbacks/0043_knowledge_extras.sql.

CREATE TABLE IF NOT EXISTS "knowledge_extras" (
	"object_id" uuid PRIMARY KEY REFERENCES "objects"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL,
	"t_valid" timestamptz NOT NULL DEFAULT now(),
	"t_invalid" timestamptz,
	"confidence" text,
	"verification_status" text NOT NULL DEFAULT 'unverified',
	"writer_type" text NOT NULL,
	"provenance_type" text NOT NULL,
	"provenance_ref" jsonb,
	CONSTRAINT "knowledge_extras_confidence_ck"
		CHECK ("confidence" IN ('low','medium','high')),
	CONSTRAINT "knowledge_extras_verification_status_ck"
		CHECK ("verification_status" IN ('unverified','pending','verified','deprecated','contested')),
	CONSTRAINT "knowledge_extras_writer_type_ck"
		CHECK ("writer_type" IN ('human','agent','system')),
	CONSTRAINT "knowledge_extras_provenance_type_ck"
		CHECK ("provenance_type" IN ('insight','meeting','slack','agent-write','manual','imported'))
);

CREATE INDEX IF NOT EXISTS "knowledge_extras_ws_t_valid_idx"
	ON "knowledge_extras" ("workspace_id", "t_valid")
	WHERE "t_invalid" IS NULL;

CREATE INDEX IF NOT EXISTS "knowledge_extras_ws_confidence_idx"
	ON "knowledge_extras" ("workspace_id", "confidence")
	WHERE "t_invalid" IS NULL;

CREATE INDEX IF NOT EXISTS "knowledge_extras_ws_verification_status_idx"
	ON "knowledge_extras" ("workspace_id", "verification_status")
	WHERE "t_invalid" IS NULL;

CREATE INDEX IF NOT EXISTS "knowledge_extras_ws_writer_type_idx"
	ON "knowledge_extras" ("workspace_id", "writer_type")
	WHERE "t_invalid" IS NULL;

CREATE INDEX IF NOT EXISTS "knowledge_extras_ws_provenance_type_idx"
	ON "knowledge_extras" ("workspace_id", "provenance_type")
	WHERE "t_invalid" IS NULL;

-- Backfill from existing knowledge rows. COPY not MOVE — objects.metadata keys
-- stay intact so any lingering reader keeps working. Unknown / out-of-enum
-- values fall back to safe defaults (writer_type -> 'system', provenance_type
-- -> 'imported', confidence -> NULL) so the CHECK constraints never trip on
-- legacy data.
INSERT INTO "knowledge_extras" (
	"object_id",
	"workspace_id",
	"t_valid",
	"t_invalid",
	"confidence",
	"verification_status",
	"writer_type",
	"provenance_type",
	"provenance_ref"
)
SELECT
	o.id,
	o.workspace_id,
	COALESCE(o.created_at, now()),
	CASE WHEN o.status = 'deprecated' THEN now() END,
	CASE
		WHEN (o.metadata->>'confidence') IN ('low','medium','high')
		THEN o.metadata->>'confidence'
	END,
	CASE WHEN o.status = 'validated' THEN 'verified' ELSE 'unverified' END,
	CASE WHEN a.type IN ('human','agent','system') THEN a.type ELSE 'system' END,
	CASE
		WHEN COALESCE(o.metadata->>'source_type','imported')
			IN ('insight','meeting','slack','agent-write','manual','imported')
		THEN COALESCE(o.metadata->>'source_type','imported')
		ELSE 'imported'
	END,
	NULL
FROM "objects" o
LEFT JOIN "actors" a ON a.id = o.created_by
WHERE o.type = 'knowledge'
ON CONFLICT ("object_id") DO NOTHING;
