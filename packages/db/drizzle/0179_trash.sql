-- Trash: reversible deletes.
--
-- One row per deleted entity, holding the full original row (jsonb), who deleted it,
-- when, and when it may be purged. Delete handlers copy the row here and then delete as
-- before, so no read path changes and a deleted row can never leak back into a list.
-- Restore re-inserts the row; loops also get their in_loop edges back from `extra`.
-- Files and workspace skills keep their stored bytes until purge_at (deleted_at + 30
-- days), when the purge job removes the bytes and the row.
--
-- kind is one of object, file, trigger, relationship, workspace_skill. There is
-- deliberately no "loop" kind: a flow is an object of type 'loop', and its extra holds
-- the membership edges.
--
-- The table is new and empty, so no lock or backfill concern. Row-level security is on
-- because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0179_trash_down.sql.
CREATE TABLE IF NOT EXISTS "trash" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"row" jsonb NOT NULL,
	"extra" jsonb,
	"deleted_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trash_kind_check" CHECK ("kind" IN ('object', 'file', 'trigger', 'relationship', 'workspace_skill'))
);
--> statement-breakpoint
ALTER TABLE "trash" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trash_ws_deleted_at_idx" ON "trash" USING btree ("workspace_id", "deleted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trash_purge_at_idx" ON "trash" USING btree ("purge_at");
