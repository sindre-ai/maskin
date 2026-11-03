-- Rollback for 0094_keychain_audit_fks_survive_deletes.sql. Restores the plain
-- foreign keys. Fails if audit rows already reference a deleted actor or integration,
-- or a chat_capture integration lost its origin session; that is the point of the
-- constraints, so clear those rows deliberately before rolling back.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "credential_access_log"
	ADD CONSTRAINT "credential_access_log_integration_id_fkey"
	FOREIGN KEY ("integration_id") REFERENCES "integrations"("id");
--> statement-breakpoint
ALTER TABLE "credential_access_log"
	ADD CONSTRAINT "credential_access_log_actor_id_fkey"
	FOREIGN KEY ("actor_id") REFERENCES "actors"("id");
--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_origin_session_id_fkey";
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_origin_session_id_fkey"
	FOREIGN KEY ("origin_session_id") REFERENCES "sessions"("id");
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_chat_capture_has_session"
	CHECK ("source" <> 'chat_capture' OR "origin_session_id" IS NOT NULL);
