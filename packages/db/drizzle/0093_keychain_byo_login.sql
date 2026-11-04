-- Keychain: a named username + password credential (provider_mode 'byo_login').
--
-- provider_mode is free text (0087), so the new mode needs no column change. The one
-- thing that does need to change is integrations_ws_actor_provider_null_external_uniq:
-- 0089 made it skip byo_apikey rows so a workspace can hold several named keys for one
-- provider. A login is a named credential in the same way (a workspace holds one per
-- site), has no external_id and, from the chat card, no actor_id, so a second login
-- would collide with the first. The index now skips both bring-your-own modes;
-- registered and byo_oauth rows keep the one-per-provider guarantee.
--
-- Not a hot table (see MIGRATIONS.md), so a plain index swap is fine.
--
-- Rollback: drizzle/down/0093_keychain_byo_login_down.sql.

DROP INDEX IF EXISTS "integrations_ws_actor_provider_null_external_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_actor_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "actor_id", "provider")
	NULLS NOT DISTINCT
	WHERE "external_id" IS NULL AND "provider_mode" NOT IN ('byo_apikey', 'byo_login');
