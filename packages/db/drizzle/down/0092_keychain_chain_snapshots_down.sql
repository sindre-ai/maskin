-- Rollback for 0092_keychain_chain_snapshots.sql. Drops the snapshot table and
-- restores the (empty) KMS alias table that 0087 created.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "credential_chain_snapshots";
--> statement-breakpoint
DROP FUNCTION IF EXISTS credential_chain_snapshots_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_kms_aliases" (
	"workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id"),
	"kek_alias" text NOT NULL,
	"provider" text NOT NULL DEFAULT 'aws-kms',
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
