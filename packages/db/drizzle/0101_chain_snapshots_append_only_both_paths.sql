-- Keychain: one append-only trigger function that allows both workspace-deletion paths.
--
-- Two migrations number 0097 and both replace credential_chain_snapshots_append_only():
-- 0097_chain_snapshots_allow_workspace_purge lets a DELETE through while
-- maskin.purging_workspace = 'on' (what workspace-purge.ts sets), and
-- 0097_keychain_audit_cascade_on_workspace_delete lets it through at trigger depth > 1 (the
-- foreign-key cascade). They run in file-name order, so the cascade-only version ran last and
-- dropped the flag path: the purge's explicit DELETE (depth 1, flag on) was rejected with
-- "credential_chain_snapshots is append-only" and every workspace deletion with a snapshot
-- failed.
--
-- This replaces the function with the union of both. UPDATE and any other DELETE are still
-- rejected. Idempotent: CREATE OR REPLACE. Replaces a function body only, no table or column
-- changes, so old code keeps working against it.
-- Down: drizzle/down/0101_chain_snapshots_append_only_both_paths_down.sql.

CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	-- A foreign-key cascade from the workspace runs this at depth 2; a direct statement is depth 1.
	IF TG_OP = 'DELETE' AND (
		pg_trigger_depth() > 1
		OR current_setting('maskin.purging_workspace', true) = 'on'
	) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
