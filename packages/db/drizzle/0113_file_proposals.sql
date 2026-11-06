-- Agent change proposals on markdown files: two new tables, nothing existing changes (expand only).
--
-- file_proposals holds one submit; file_proposal_changes holds its text changes, each with its own
-- status. Staleness is not stored, it is computed on read from the file's current bytes.
-- Neither table is on the hot-tables list (docs: MIGRATIONS.md): proposals are written by an agent
-- on a deliberate edit and read by a person reviewing them.
-- Row-level security is switched on for both tables because 0111_enable_rls_public_tables ran before they existed.
-- Down: drizzle/down/0113_file_proposals_down.sql.

CREATE TABLE IF NOT EXISTS "file_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"author_id" uuid NOT NULL REFERENCES "actors"("id"),
	"session_id" uuid,
	"summary" text,
	"base_sha256" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "file_proposals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_proposals_file_created_at_idx" ON "file_proposals" ("file_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_proposal_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL REFERENCES "file_proposals"("id") ON DELETE CASCADE,
	"ordinal" integer NOT NULL,
	"old_text" text NOT NULL,
	"new_text" text NOT NULL,
	"reason" text,
	"context_before" text NOT NULL DEFAULT '',
	"context_after" text NOT NULL DEFAULT '',
	"status" text NOT NULL DEFAULT 'pending',
	"decided_by" uuid REFERENCES "actors"("id"),
	"decided_at" timestamp with time zone,
	"applied_text" text,
	CONSTRAINT "file_proposal_changes_proposal_ordinal_unique" UNIQUE ("proposal_id", "ordinal"),
	CONSTRAINT "file_proposal_changes_status_check" CHECK ("status" IN ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "file_proposal_changes" ENABLE ROW LEVEL SECURITY;
