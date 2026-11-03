-- Actor-scoped credentials in `integrations`, foundation for the LinkedIn MCP
-- bet. Adds a nullable `actor_id` column and reshapes the two workspace-scoped
-- unique indexes to include it — so `(workspace_id, actor_id, provider, ...)`
-- tuples are the new uniqueness contract. Existing workspace-scoped providers
-- (Slack, Gmail, GitHub, etc.) keep writing `actor_id = NULL`; the new
-- `linkedin-unipile` provider is the only one that will populate the column
-- via the `actorScopedProviders` allow-list in
-- apps/dev/src/lib/integrations/lookup.ts. NO BACKFILL: pre-existing rows
-- carry `actor_id = NULL`; the new indexes are declared NULLS NOT DISTINCT
-- (see below) so two rows with the same (workspace_id, provider [, external_id])
-- and NULL actor_id still collide — preserving their prior workspace-scoped
-- uniqueness semantics without a data migration.
--
-- Also adds a non-unique `(workspace_id, provider)` helper index so cross-actor
-- provider-lookup queries (e.g. "list all connected LinkedIn actors in this
-- workspace" from Task 5's Sales Rep loop) don't have to seq-scan.
--
-- The DROP and CREATE run in the same file so a partial apply can't leave
-- the table without a unique guard (see postgres.js single-simple-query
-- implicit transaction wrapping, packages/db/src/migrate-utils.ts). Down
-- migration lives at `drizzle/down/0065_integrations_actor_id_down.sql` —
-- the `down/` subdir is invisible to migrate.ts because readdirSync +
-- .endsWith('.sql') filters it out (same carve-out as `meta/`).

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "actor_id" uuid REFERENCES "actors"("id");

DROP INDEX IF EXISTS "integrations_ws_provider_external_uniq";
DROP INDEX IF EXISTS "integrations_ws_provider_null_external_uniq";

-- NULLS NOT DISTINCT so workspace-scoped rows (actor_id = NULL) still collide
-- on (workspace_id, provider [, external_id]) — preserving the pre-0065
-- uniqueness contract and keeping ON CONFLICT semantics of upserts that don't
-- populate actor_id (every non-linkedin-unipile provider).
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_actor_provider_external_uniq"
	ON "integrations" ("workspace_id", "actor_id", "provider", "external_id")
	NULLS NOT DISTINCT
	WHERE "external_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_actor_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "actor_id", "provider")
	NULLS NOT DISTINCT
	WHERE "external_id" IS NULL;

CREATE INDEX IF NOT EXISTS "integrations_ws_provider_idx"
	ON "integrations" ("workspace_id", "provider");
