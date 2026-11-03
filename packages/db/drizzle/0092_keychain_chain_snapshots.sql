-- Keychain: no AWS. Two changes.
--   1. credential_chain_snapshots: the daily audit-chain head, one row per
--      workspace per UTC day. Append-only: a trigger rejects UPDATE and DELETE for
--      every role, so a snapshot can only be added, never edited. Whoever owns the
--      database can still drop the trigger or truncate the table; this catches
--      edits by the application and by anyone who is not an owner.
--   2. workspace_kms_aliases is dropped: the master key lives in the environment
--      (KEYCHAIN_MASTER_KEY), not in a per-workspace KMS key.
-- Down: drizzle/down/0092_keychain_chain_snapshots_down.sql.

CREATE TABLE IF NOT EXISTS "credential_chain_snapshots" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"snapshot_date" date NOT NULL,
	"max_id" bigint NOT NULL,
	"row_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY ("workspace_id", "snapshot_date")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION credential_chain_snapshots_append_only() RETURNS trigger
	LANGUAGE plpgsql AS
$$
BEGIN
	RAISE EXCEPTION 'credential_chain_snapshots is append-only';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "credential_chain_snapshots_no_change" ON "credential_chain_snapshots";
--> statement-breakpoint
CREATE TRIGGER "credential_chain_snapshots_no_change" BEFORE UPDATE OR DELETE ON "credential_chain_snapshots"
	FOR EACH ROW EXECUTE FUNCTION credential_chain_snapshots_append_only();
--> statement-breakpoint
DROP TABLE IF EXISTS "workspace_kms_aliases";
