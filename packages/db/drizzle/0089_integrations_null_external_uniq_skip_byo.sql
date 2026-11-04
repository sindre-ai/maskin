-- Keychain: let one workspace hold several bring-your-own keys for one provider.
--
-- integrations_ws_actor_provider_null_external_uniq (0065) allows one row per
-- (workspace, actor, provider) where external_id IS NULL, NULLS NOT DISTINCT. It was
-- built for the registered providers (Slack, Gmail and the like): one connection
-- per workspace. A BYO key has no external_id and, from chat capture and the paste
-- form, no actor_id either, so a second key for one provider collided with the
-- first, and an undone row kept counting, so capture, undo, capture failed too.
--
-- The index now skips byo_apikey rows. Registered rows and byo_oauth rows (which
-- hold a connection, not a named key) keep the one-per-provider guarantee.
--
-- provider_mode is NOT NULL DEFAULT 'registered' (0087), so the <> predicate cannot
-- drop a row from the index through a NULL.
--
-- integrations_ws_actor_provider_external_uniq (external_id IS NOT NULL), which the
-- upsert in routes/integrations.ts targets, is not touched.
--
-- Rollback: drizzle/down/0089_integrations_null_external_uniq_skip_byo_down.sql.

DROP INDEX IF EXISTS "integrations_ws_actor_provider_null_external_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_actor_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "actor_id", "provider")
	NULLS NOT DISTINCT
	WHERE "external_id" IS NULL AND "provider_mode" <> 'byo_apikey';
