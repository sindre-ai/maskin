-- Keychain core (bet d46bb7f2, PR #1). Three things, all additive:
--   1. integrations: provider_mode, display_name, scope_grants, dek_ciphertext,
--      source, origin_session_id, undo_expires_at, plus indexes and CHECKs.
--      Existing rows default to registered / admin_ui / NULL dek_ciphertext /
--      empty scope_grants (fail-closed: they stay unreadable through
--      getCredential until a grant is written). No backfill.
--   2. workspace_kms_aliases: workspace -> KMS key alias.
--   3. credential_access_log: hash-chained, insert-only audit log of credential
--      use. credential_access_log_insert() is a BEFORE INSERT trigger that
--      assigns id, prev_row_hash and row_hash under a per-workspace advisory
--      lock, so a caller cannot choose them and the chain order equals id order.
--
-- row_hash covers read_at as ONE canonical text form, credential_access_log_ts_text():
-- UTC, microsecond precision, as Postgres renders it. A JavaScript Date keeps
-- only milliseconds, so a verifier that hashed a Date would fail on every row.
--
-- The app writes audit rows as role maskin_keychain_app (INSERT and SELECT on
-- the log, no UPDATE, DELETE or TRUNCATE) via SET LOCAL ROLE inside getCredential.
-- CREATE ROLE needs CREATEROLE or superuser; if this migration cannot create it
-- the deploy fails here, loudly, rather than at the first credential read.
--
-- integrations is not on the hot-tables list (packages/db/MIGRATIONS.md), so
-- plain CREATE INDEX is fine. Down: drizzle/down/0087_keychain_core_down.sql.

ALTER TABLE "integrations"
	ADD COLUMN IF NOT EXISTS "provider_mode" text NOT NULL DEFAULT 'registered',
	ADD COLUMN IF NOT EXISTS "display_name" text,
	ADD COLUMN IF NOT EXISTS "scope_grants" jsonb NOT NULL DEFAULT '[]'::jsonb,
	ADD COLUMN IF NOT EXISTS "dek_ciphertext" text,
	ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'admin_ui',
	ADD COLUMN IF NOT EXISTS "origin_session_id" uuid REFERENCES "sessions"("id"),
	ADD COLUMN IF NOT EXISTS "undo_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_ws_mode_idx" ON "integrations" ("workspace_id", "provider_mode");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_undo_sweeper_idx" ON "integrations" ("status", "undo_expires_at") WHERE "status" = 'pending_undo';
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP CONSTRAINT IF EXISTS "integrations_byo_needs_display_name",
	DROP CONSTRAINT IF EXISTS "integrations_scope_grants_is_array",
	DROP CONSTRAINT IF EXISTS "integrations_source_enum",
	DROP CONSTRAINT IF EXISTS "integrations_chat_capture_has_session";
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_byo_needs_display_name" CHECK ("provider_mode" = 'registered' OR "display_name" IS NOT NULL),
	ADD CONSTRAINT "integrations_scope_grants_is_array" CHECK (jsonb_typeof("scope_grants") = 'array'),
	ADD CONSTRAINT "integrations_source_enum" CHECK ("source" IN ('admin_ui', 'chat_capture', 'oauth_callback', 'registry_install')),
	ADD CONSTRAINT "integrations_chat_capture_has_session" CHECK ("source" <> 'chat_capture' OR "origin_session_id" IS NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_kms_aliases" (
	"workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id"),
	"kek_alias" text NOT NULL,
	"provider" text NOT NULL DEFAULT 'aws-kms',
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credential_access_log" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"session_id" uuid,
	"loop_id" uuid,
	"outbound_target" text,
	"action" text NOT NULL DEFAULT 'read',
	"source" text NOT NULL DEFAULT 'unknown',
	"request_id" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL DEFAULT now(),
	"prev_row_hash" text NOT NULL DEFAULT '',
	"row_hash" text NOT NULL DEFAULT '',
	CONSTRAINT "credential_access_log_action_enum" CHECK ("action" IN ('read', 'create', 'undone', 'rotated', 'sweeper_activated'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_ws_read_at_idx" ON "credential_access_log" ("workspace_id", "read_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_integration_read_at_idx" ON "credential_access_log" ("integration_id", "read_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_actor_read_at_idx" ON "credential_access_log" ("actor_id", "read_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_action_idx" ON "credential_access_log" ("workspace_id", "action");
--> statement-breakpoint
-- Not in the spec's index list: the trigger below reads the highest id of a
-- workspace on every insert, which without this is a backward scan of the PK.
CREATE INDEX IF NOT EXISTS "cal_ws_id_idx" ON "credential_access_log" ("workspace_id", "id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION credential_access_log_ts_text(ts timestamp with time zone) RETURNS text
	LANGUAGE sql IMMUTABLE AS
$$ SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION credential_access_log_insert() RETURNS trigger
	LANGUAGE plpgsql AS
$$
DECLARE
	head text;
BEGIN
	-- One chain per workspace. The lock is taken BEFORE the id is assigned, so
	-- chain order and id order cannot diverge under concurrent inserts.
	PERFORM pg_advisory_xact_lock(hashtextextended('credential_access_log:' || NEW.workspace_id::text, 0));
	NEW.id := nextval(pg_get_serial_sequence('credential_access_log', 'id'));
	SELECT row_hash INTO head
		FROM credential_access_log
		WHERE workspace_id = NEW.workspace_id
		ORDER BY id DESC
		LIMIT 1;
	-- Genesis constant for row one: sha256 of the string below. The TS verifier
	-- (apps/dev/src/lib/integrations/credential-audit.ts) uses the same one.
	NEW.prev_row_hash := coalesce(head, encode(sha256(convert_to('maskin-credential-access-log-genesis-v1', 'UTF8')), 'hex'));
	-- Fields joined by chr(31) (unit separator) so adjacent values cannot shift
	-- into each other. NULL session_id and outbound_target hash as ''.
	NEW.row_hash := encode(sha256(convert_to(concat_ws(chr(31),
		NEW.prev_row_hash,
		NEW.workspace_id::text,
		NEW.integration_id::text,
		NEW.actor_id::text,
		coalesce(NEW.session_id::text, ''),
		coalesce(NEW.outbound_target, ''),
		NEW.action,
		NEW.source,
		NEW.request_id,
		credential_access_log_ts_text(NEW.read_at)
	), 'UTF8')), 'hex');
	RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "credential_access_log_chain" ON "credential_access_log";
--> statement-breakpoint
CREATE TRIGGER "credential_access_log_chain" BEFORE INSERT ON "credential_access_log"
	FOR EACH ROW EXECUTE FUNCTION credential_access_log_insert();
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maskin_keychain_app') THEN
		CREATE ROLE maskin_keychain_app NOLOGIN;
	END IF;
END
$$;
--> statement-breakpoint
GRANT maskin_keychain_app TO CURRENT_USER;
--> statement-breakpoint
REVOKE ALL ON "credential_access_log" FROM PUBLIC;
--> statement-breakpoint
-- A schema recreated with CREATE SCHEMA public (as the integration harness does)
-- carries no default USAGE for PUBLIC, and the role could not see the table.
GRANT USAGE ON SCHEMA public TO maskin_keychain_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON "credential_access_log" TO maskin_keychain_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "credential_access_log_id_seq" TO maskin_keychain_app;
