-- Promotes customer metadata (segment, confidence, last_validated,
-- evidence_count) from opaque JSONB into first-class columns on a new
-- extension-owned table under the CRM extension. Sits 1:1 with `objects` rows
-- where type='customer', keyed on `object_id` (PK + FK ON DELETE CASCADE).
-- `objects.metadata` is left intact — this is COPY, not MOVE. Table exists in
-- every workspace but stays empty when the CRM extension is disabled, so the
-- base-schema E2E path is unaffected.
--
-- Rollback: see packages/db/rollbacks/0048_crm_customer_extras.sql.

CREATE TABLE IF NOT EXISTS "crm_customer_extras" (
	"object_id" uuid PRIMARY KEY REFERENCES "objects"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL,
	"segment" text,
	"confidence" text,
	"last_validated" date,
	"evidence_count" integer,
	CONSTRAINT "crm_customer_extras_confidence_ck"
		CHECK ("confidence" IN ('low','medium','high')),
	CONSTRAINT "crm_customer_extras_evidence_count_nonneg_ck"
		CHECK ("evidence_count" IS NULL OR "evidence_count" >= 0)
);

-- One partial index per promoted filter target, keyed on (workspace_id, <field>).
-- WHERE <field> IS NOT NULL so sparse rows don't bloat the index — most
-- customers won't have every field set.
CREATE INDEX IF NOT EXISTS "crm_customer_extras_ws_segment_idx"
	ON "crm_customer_extras" ("workspace_id", "segment")
	WHERE "segment" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_customer_extras_ws_confidence_idx"
	ON "crm_customer_extras" ("workspace_id", "confidence")
	WHERE "confidence" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_customer_extras_ws_last_validated_idx"
	ON "crm_customer_extras" ("workspace_id", "last_validated")
	WHERE "last_validated" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "crm_customer_extras_ws_evidence_count_idx"
	ON "crm_customer_extras" ("workspace_id", "evidence_count")
	WHERE "evidence_count" IS NOT NULL;

-- Backfill from existing customer rows. COPY not MOVE — objects.metadata keys
-- stay intact so any lingering reader keeps working. Every customer gets a row
-- so future filter queries can `LEFT JOIN crm_customer_extras` and read the
-- promoted columns directly (all nullable — only whatever agents happened to
-- write is carried across). Out-of-enum / out-of-shape values fall back to
-- NULL rather than tripping a cast error: `confidence` outside the CHECK set
-- → NULL, non-date text → NULL, non-integer / negative text → NULL.
INSERT INTO "crm_customer_extras" (
	"object_id",
	"workspace_id",
	"segment",
	"confidence",
	"last_validated",
	"evidence_count"
)
SELECT
	o.id,
	o.workspace_id,
	NULLIF(o.metadata->>'segment', ''),
	CASE
		WHEN (o.metadata->>'confidence') IN ('low','medium','high')
		THEN o.metadata->>'confidence'
	END,
	CASE
		WHEN (o.metadata->>'last_validated') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
		THEN (o.metadata->>'last_validated')::date
	END,
	CASE
		WHEN (o.metadata->>'evidence_count') ~ '^[0-9]+$'
		THEN (o.metadata->>'evidence_count')::integer
	END
FROM "objects" o
WHERE o.type = 'customer'
ON CONFLICT ("object_id") DO NOTHING;
