-- Keychain: the chain snapshots are erased together with their workspace.
--
-- Deleting a workspace has to erase its audit trail (the log rows and the daily chain
-- snapshots), otherwise the actor ids and outbound targets of a departed customer stay in
-- the database and the delete is refused for every workspace that ever read a credential.
-- Migration 0094 kept the workspace foreign keys NO ACTION without deciding retention.
--
-- Two changes, both on credential_chain_snapshots:
--   1. The workspace foreign key becomes ON DELETE CASCADE.
--   2. The append-only trigger function now allows a DELETE only when the parent workspace
--      row no longer exists. A cascade runs after the workspace row is deleted, so only a real
--      workspace delete passes; a direct DELETE of a snapshot still raises. UPDATE always
--      raises. The trigger itself is unchanged (still BEFORE UPDATE OR DELETE, every role).
--
-- credential_access_log needs no schema change: it has no delete trigger, and workspace-purge
-- deletes its rows by hand before the workspace row.
-- Down: drizzle/down/0097_snapshots_deleted_with_workspace_down.sql.

DO $$
DECLARE
	con record;
BEGIN
	FOR con IN
		SELECT c.conname
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid = 'credential_chain_snapshots'::regclass
			AND c.contype = 'f'
			AND a.attname = 'workspace_id'
	LOOP
		EXECUTE format('ALTER TABLE credential_chain_snapshots DROP CONSTRAINT %I', con.conname);
	END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "credential_chain_snapshots"
	ADD CONSTRAINT "credential_chain_snapshots_workspace_id_fkey"
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
