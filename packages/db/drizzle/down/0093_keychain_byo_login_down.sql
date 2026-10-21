-- Rollback for 0093_keychain_byo_login.sql.
--
-- PRECONDITION: restores the 0089 predicate, so it FAILS if two byo_login rows share
-- (workspace_id, actor_id, provider), including undone ones. Delete the byo_login rows
-- (or keep one per provider) first; there is no correct automatic answer.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP INDEX IF EXISTS "integrations_ws_actor_provider_null_external_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_actor_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "actor_id", "provider")
	NULLS NOT DISTINCT
	WHERE "external_id" IS NULL AND "provider_mode" <> 'byo_apikey';
