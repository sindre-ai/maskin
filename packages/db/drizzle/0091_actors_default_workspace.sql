-- A human's preferred workspace, set from Settings and surfaced by the MCP
-- list_workspaces tool.
--
-- Nullable with no default, so this is a metadata-only ALTER (expand step): every
-- reader and writer of the previous code is unaffected, and NULL means "no
-- preference". The FK is ON DELETE SET NULL so deleting a workspace clears the
-- preference instead of blocking the delete. actors is not on the hot-table list in
-- MIGRATIONS.md.
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "default_workspace_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "actors" ADD CONSTRAINT "actors_default_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("default_workspace_id") REFERENCES "public"."workspaces"("id")
		ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
