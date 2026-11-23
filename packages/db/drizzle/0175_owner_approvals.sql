-- The owner approval record (bet "Installable accounting flow with Danish connectors", task "Give
-- the owner one review screen"). One shared table for every "the owner approved this" that later
-- steps read: kind says what was approved (the first kind is dinero_books, the owner's final
-- approval of a period's books), subject says which one, figures_hash is a sha256 of the figures
-- the owner saw, so a later step can check it still matches. expires_at and used_at are for steps
-- that consume an approval once; the review screen sets neither.
-- approved_by carries no foreign key: it is a record, so the account-deletion guard has nothing to
-- chase. workspace_id cascades.
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine.
-- Row-level security is switched on because 0111_enable_rls_public_tables ran before it existed.
-- Down: drizzle/down/0175_owner_approvals_down.sql.

CREATE TABLE IF NOT EXISTS "owner_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"figures_hash" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL DEFAULT now(),
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_approvals_ws_kind_subject_idx"
	ON "owner_approvals" USING btree ("workspace_id", "kind", "subject");
--> statement-breakpoint
ALTER TABLE "owner_approvals" ENABLE ROW LEVEL SECURITY;
