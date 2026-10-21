-- Keychain: deleting a workspace erases its audit trail with it.
--
-- 0094 left workspace_id on credential_access_log and credential_chain_snapshots as a
-- plain (NO ACTION) foreign key, so "deleting a workspace with an audit trail stays
-- refused". That contradicts hard-deleting a workspace (workspace-purge.ts), which
-- removes every row the workspace owns, so a workspace that ever used Keychain could
-- never be deleted (FK 23503).
--
-- Both foreign keys become ON DELETE CASCADE. credential_chain_snapshots is guarded by
-- an append-only trigger that rejects every DELETE, so the trigger now lets a DELETE
-- through only when it was fired by a foreign-key cascade (pg_trigger_depth() > 1: the
-- cascade's own RI trigger is depth 1, this one runs inside it). A direct DELETE or any
-- UPDATE from application code is still rejected. credential_access_log has no such
-- trigger: its insert-only guarantee is that the app role holds no DELETE privilege,
-- which the cascade does not need (referential actions run as the table owner).
-- Down: drizzle/down/0097_keychain_audit_cascade_on_workspace_delete_down.sql.

DO $$
DECLARE
	con record;
BEGIN
	FOR con IN
		SELECT c.conrelid::regclass AS tbl, c.conname
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid IN ('credential_access_log'::regclass, 'credential_chain_snapshots'::regclass)
			AND c.contype = 'f'
			AND a.attname = 'workspace_id'
	LOOP
		EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', con.tbl, con.conname);
	END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "credential_access_log"
	ADD CONSTRAINT "credential_access_log_workspace_id_fkey"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE NOT VALID;
--> statement-breakpoint
ALTER TABLE "credential_access_log" VALIDATE CONSTRAINT "credential_access_log_workspace_id_fkey";
--> statement-breakpoint
ALTER TABLE "credential_chain_snapshots"
	ADD CONSTRAINT "credential_chain_snapshots_workspace_id_fkey"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	-- Deleting the workspace cascades here at depth 2; a direct statement is depth 1.
	IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
