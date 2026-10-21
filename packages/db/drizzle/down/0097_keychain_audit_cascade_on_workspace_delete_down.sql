-- Rollback for 0097_keychain_audit_cascade_on_workspace_delete.sql. Restores the plain
-- foreign keys and the trigger that rejects every DELETE.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
--> statement-breakpoint
ALTER TABLE "credential_chain_snapshots" DROP CONSTRAINT IF EXISTS "credential_chain_snapshots_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "credential_chain_snapshots"
	ADD CONSTRAINT "credential_chain_snapshots_workspace_id_fkey"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");
--> statement-breakpoint
ALTER TABLE "credential_access_log" DROP CONSTRAINT IF EXISTS "credential_access_log_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "credential_access_log"
	ADD CONSTRAINT "credential_access_log_workspace_id_fkey"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");
