-- Rollback for 0101: back to the cascade-only version that 0097_keychain_audit_cascade_on_workspace_delete
-- leaves on a fresh database.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
