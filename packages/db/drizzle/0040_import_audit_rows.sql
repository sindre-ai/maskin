-- Per-row audit trail for bulk imports run with configurable dedup keys.
-- One row per CSV row resolved by the import processor — records the action
-- taken (created / updated / skipped / failed), the diff columns when an
-- existing object was updated, and the pre/post values for the diff.
--
-- FK to `imports` is ON DELETE CASCADE so the audit follows the parent
-- import's lifetime. `object_id` is nullable because `skipped` / `failed`
-- outcomes have no resolved object. JSONB columns carry empty defaults so
-- writers can omit them for `created` / `skipped` / `failed` rows.
--
-- No backfill: audit applies only to imports executed after this migration
-- ships (see bet AC-T5). Pre-migration `imports` rows simply have no audit
-- children, which is the correct historical record.
--
-- To revert: DROP TABLE "import_audit_rows";
-- The CASCADE FK means dropping the table leaves no orphan rows; nothing
-- else references `import_audit_rows`.

CREATE TABLE "import_audit_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL REFERENCES "imports" ("id") ON DELETE CASCADE,
	"row_index" integer NOT NULL,
	"object_id" uuid,
	"action" text NOT NULL,
	"changed_columns" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"old_values" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"new_values" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "import_audit_rows_action_check"
		CHECK ("action" IN ('created', 'updated', 'skipped', 'failed'))
);

CREATE INDEX "import_audit_rows_import_id_idx"
	ON "import_audit_rows" USING btree ("import_id");
