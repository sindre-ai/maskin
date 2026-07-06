-- Promotes knowledge metadata (provenance, bi-temporal validity, confidence,
-- verification, writer-type) from opaque JSONB into first-class columns on a
-- new extension-owned table. Sits 1:1 with `objects` rows where type='knowledge',
-- keyed on `object_id` (PK + FK ON DELETE CASCADE). `objects.metadata` is left
-- intact — this is COPY, not MOVE. Table exists in every workspace but stays
-- empty for workspaces that never had the knowledge module enabled, so the
-- base-schema E2E path is unaffected. Note: disabling the module after rows
-- exist does not purge them — see apps/dev/src/routes/objects.ts for the
-- read-path module-enabled gate that keeps disabled workspaces on the
-- generic query path regardless.
--
-- Rollback: see packages/db/rollbacks/0047_knowledge_extras.sql.

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
--
-- `objects.status` values are workspace-configurable (workspaces.settings.
-- statuses.knowledge can rename the default ['draft','validated','deprecated']
-- labels), so the validated/deprecated equivalents are read per-workspace from
-- that array by position (index 1 = validated-equivalent, index 2 = deprecated-
-- equivalent — the position the knowledge module seeds on enable, see
-- extensions/knowledge/shared.ts KNOWLEDGE_STATUSES / buildEnableModuleSettings
-- in packages/mcp/src/server.ts) rather than the hardcoded English labels. A
-- missing settings array (legacy workspace, or module enabled outside that
-- flow) falls back to the default labels.
--
-- Positional trust is guarded on array shape: `update_extension` lets a
-- workspace freely replace `statuses.knowledge` with any array (any order,
-- any length — see packages/mcp/src/tools.ts `statuses: z.array(z.string())`,
-- no positional constraint enforced). If a workspace reordered or resized
-- that array before this migration runs, indexes 1/2 no longer mean
-- validated/deprecated, and reading them anyway would silently invalidate
-- live content or verify stale content. So the label lookup below only
-- trusts positions 1/2 when the array is still exactly 3 elements — the
-- shape the module seeds and the shape the "renamed but same order" case
-- (the supported customization) always has. Any other shape (missing, or
-- present but not length 3) resolves to NULL, which never equals a real
-- `objects.status` value, so the corresponding CASE simply doesn't match —
-- the safe "we don't know this workspace's mapping" default (unverified,
-- not invalidated) rather than a guess.
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
	CASE
		WHEN o.status = labels.deprecated_label
		THEN now()
	END,
	CASE
		WHEN (o.metadata->>'confidence') IN ('low','medium','high')
		THEN o.metadata->>'confidence'
	END,
	CASE
		WHEN o.status = labels.validated_label
		THEN 'verified'
		ELSE 'unverified'
	END,
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
LEFT JOIN "workspaces" w ON w.id = o.workspace_id
LEFT JOIN LATERAL (
	SELECT
		CASE
			WHEN w.settings->'statuses'->'knowledge' IS NULL THEN 'validated'
			WHEN jsonb_array_length(w.settings->'statuses'->'knowledge') = 3
				THEN w.settings->'statuses'->'knowledge'->>1
			ELSE NULL
		END AS validated_label,
		CASE
			WHEN w.settings->'statuses'->'knowledge' IS NULL THEN 'deprecated'
			WHEN jsonb_array_length(w.settings->'statuses'->'knowledge') = 3
				THEN w.settings->'statuses'->'knowledge'->>2
			ELSE NULL
		END AS deprecated_label
) labels ON true
WHERE o.type = 'knowledge'
ON CONFLICT ("object_id") DO NOTHING;
