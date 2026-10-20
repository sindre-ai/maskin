-- Rollback for 0095_agent_grants.sql. Restores integrations.scope_grants from the
-- agent_grants rows (one actor grant each, access level is lost), then drops the new
-- table and column. Workspace-kind grants dropped by the forward migration are NOT
-- restored; re-run the 0088 backfill for google-meet and linkedin-unipile if needed.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "scope_grants" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
UPDATE "integrations" i SET "scope_grants" = COALESCE((
	SELECT jsonb_agg(jsonb_build_object('kind', 'actor', 'actorId', g."actor_id"))
	FROM "agent_grants" g WHERE g."integration_id" = i."id"
), '[]'::jsonb);
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_scope_grants_is_array" CHECK (jsonb_typeof("scope_grants") = 'array');
--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_default_agent_access_enum";
--> statement-breakpoint
ALTER TABLE "integrations" DROP COLUMN IF EXISTS "default_agent_access";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_grants";
