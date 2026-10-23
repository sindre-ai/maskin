-- Keychain: make the snapshot trigger accept BOTH ways a workspace deletion removes snapshots.
--
-- Two migrations are numbered 0097 and both redefine credential_chain_snapshots_append_only():
-- 0097_chain_snapshots_allow_workspace_purge lets a DELETE through when the transaction set
-- maskin.purging_workspace = 'on' (what purgeWorkspace does), and
-- 0097_keychain_audit_cascade_on_workspace_delete lets it through only inside a foreign-key
-- cascade (pg_trigger_depth() > 1). Files replay in name order, so the second one wins on a
-- fresh database and the first one's flag is ignored: the purge's own DELETE (depth 1) is
-- rejected and every workspace delete answers 500.
--
-- This redefines the function once more, after both, so the result no longer depends on which
-- of them ran last. A direct DELETE without the flag, and every UPDATE, are still rejected.
-- Do not edit the two applied 0097 files. Idempotent (CREATE OR REPLACE).
-- Down: drizzle/down/0101_chain_snapshots_purge_and_cascade_down.sql.

CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	IF TG_OP = 'DELETE' AND (
		current_setting('maskin.purging_workspace', true) = 'on'
		OR pg_trigger_depth() > 1
	) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
