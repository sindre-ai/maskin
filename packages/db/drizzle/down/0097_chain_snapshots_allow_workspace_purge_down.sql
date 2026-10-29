-- Rollback for 0097: the snapshot table rejects every UPDATE and DELETE again.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
