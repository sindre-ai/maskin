-- Keychain: let a workspace deletion remove the audit-chain snapshots.
--
-- credential_chain_snapshots rejects every UPDATE and DELETE (migration 0092), so a
-- workspace that has ever had a snapshot could not be hard-deleted: the purge
-- (apps/dev/src/lib/workspace-purge.ts) failed on it. The audit trail dies with the
-- workspace, so the trigger now steps aside for one case only: a DELETE inside a
-- transaction that has set maskin.purging_workspace = 'on' (transaction-local,
-- set_config(..., true)). UPDATE and any other DELETE are still rejected.
-- Down: drizzle/down/0097_chain_snapshots_allow_workspace_purge_down.sql.

CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	IF TG_OP = 'DELETE' AND current_setting('maskin.purging_workspace', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
