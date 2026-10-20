-- Rollback for 0101: back to the cascade-only function that 0097_keychain_audit_cascade_on_workspace_delete
-- left in place (a direct DELETE from the workspace purge is rejected again).
--
-- Lives under drizzle/down/ so the forward runner never sees it.

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
