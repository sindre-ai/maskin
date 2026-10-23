-- Rollback for 0087_keychain_core.sql. Drops the audit log (and with it the
-- hash chain), the KMS alias table, and the Keychain columns on integrations.
--
-- PRECONDITION: DESTRUCTIVE. credential_access_log is the tamper-evident audit
-- trail and the WORM snapshots point at its chain head: export it first. Rows
-- written by the envelope path keep ciphertext in credentials and the wrapped
-- DEK in dek_ciphertext; dropping dek_ciphertext makes them undecryptable, so
-- roll back only before any envelope-encrypted row exists.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TRIGGER IF EXISTS "credential_access_log_chain" ON "credential_access_log";
--> statement-breakpoint
DROP TABLE IF EXISTS "credential_access_log";
--> statement-breakpoint
DROP FUNCTION IF EXISTS credential_access_log_insert();
--> statement-breakpoint
DROP FUNCTION IF EXISTS credential_access_log_ts_text(timestamp with time zone);
--> statement-breakpoint
DROP TABLE IF EXISTS "workspace_kms_aliases";
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP CONSTRAINT IF EXISTS "integrations_byo_needs_display_name",
	DROP CONSTRAINT IF EXISTS "integrations_scope_grants_is_array",
	DROP CONSTRAINT IF EXISTS "integrations_source_enum",
	DROP CONSTRAINT IF EXISTS "integrations_chat_capture_has_session";
--> statement-breakpoint
DROP INDEX IF EXISTS "integrations_undo_sweeper_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "integrations_ws_mode_idx";
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP COLUMN IF EXISTS "undo_expires_at",
	DROP COLUMN IF EXISTS "origin_session_id",
	DROP COLUMN IF EXISTS "source",
	DROP COLUMN IF EXISTS "dek_ciphertext",
	DROP COLUMN IF EXISTS "scope_grants",
	DROP COLUMN IF EXISTS "display_name",
	DROP COLUMN IF EXISTS "provider_mode";
--> statement-breakpoint
-- The role is cluster-wide; DROP OWNED revokes its grants in this database
-- first. If another database in the cluster still grants it privileges (a second
-- Maskin database on the same server), the role stays and the rollback goes on.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maskin_keychain_app') THEN
		DROP OWNED BY maskin_keychain_app;
		BEGIN
			DROP ROLE maskin_keychain_app;
		EXCEPTION WHEN dependent_objects_still_exist THEN
			RAISE NOTICE 'role maskin_keychain_app kept: still used in another database';
		END;
	END IF;
END
$$;
