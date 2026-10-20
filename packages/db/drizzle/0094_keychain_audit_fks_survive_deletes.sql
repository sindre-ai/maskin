-- Keychain: the audit log and the capture origin must not block deletes.
--
-- credential_access_log is insert-only, so a row that references an actor or an
-- integration can never be removed. With a plain (NO ACTION) foreign key that made
-- every agent that had read a credential undeletable, and every loop-owned integration
-- with audit rows un-uninstallable (FK 23503 -> 500). The log keeps the uuid as plain
-- history; integrity of the record is carried by the hash chain, not by the FK.
--
-- integrations.origin_session_id pointed at sessions(id) with NO ACTION, so deleting a
-- session that captured a key failed. It becomes ON DELETE SET NULL, and the
-- chat_capture-has-a-session CHECK (a creation-time rule the code enforces) goes,
-- because SET NULL would otherwise violate it.
--
-- workspace_id keeps its FK: deleting a workspace with an audit trail stays refused.
-- Down: drizzle/down/0094_keychain_audit_fks_survive_deletes_down.sql.

DO $$
DECLARE
	con record;
BEGIN
	FOR con IN
		SELECT c.conname
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
		WHERE c.conrelid = 'credential_access_log'::regclass
			AND c.contype = 'f'
			AND a.attname IN ('actor_id', 'integration_id')
	LOOP
		EXECUTE format('ALTER TABLE credential_access_log DROP CONSTRAINT %I', con.conname);
	END LOOP;
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
		WHERE c.conrelid = 'integrations'::regclass
			AND c.contype = 'f'
			AND a.attname = 'origin_session_id'
	LOOP
		EXECUTE format('ALTER TABLE integrations DROP CONSTRAINT %I', con.conname);
	END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_origin_session_id_fkey"
	FOREIGN KEY ("origin_session_id") REFERENCES "sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_chat_capture_has_session";
