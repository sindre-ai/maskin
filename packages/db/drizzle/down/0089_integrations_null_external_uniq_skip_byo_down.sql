-- Rollback for 0089_integrations_null_external_uniq_skip_byo.sql.
--
-- PRECONDITION: this restores the old predicate, so it FAILS if two byo_apikey rows
-- share (workspace_id, actor_id, provider), including undone ones. That is the state
-- 0089 exists to allow. An operator must decide what happens to those rows (delete
-- them, or keep one per provider) before rolling back; there is no correct automatic
-- answer, so this file deliberately does not choose.
--
-- ORDER: run this before the 0087 down. The index has a predicate on provider_mode, so
-- dropping that column (0087 down) drops the index with it, silently.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP INDEX IF EXISTS "integrations_ws_actor_provider_null_external_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_actor_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "actor_id", "provider")
	NULLS NOT DISTINCT
	WHERE "external_id" IS NULL;
