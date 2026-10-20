-- Rollback for 0097_snapshots_deleted_with_workspace.sql. Restores the plain (NO ACTION)
-- workspace foreign key and the trigger function that rejects every UPDATE and DELETE.
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
	FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id");
