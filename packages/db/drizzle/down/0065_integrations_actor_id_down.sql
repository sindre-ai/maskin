-- Rollback for 0065_integrations_actor_id.sql. Restores the prior
-- workspace-scoped uniqueness contract on `integrations` by dropping the
-- three new indexes and re-creating the two originals, then drops the
-- `actor_id` column. Written so a round-trip up → down → up leaves the
-- database in the same shape it started in — exercised by the reversibility
-- test in apps/dev/src/__tests__/integration/integrations-actor-scoped.test.ts.
--
-- Lives under `drizzle/down/` so the forward-migration runner (which uses
-- readdirSync + .endsWith('.sql') on `drizzle/`) never sees it — same
-- carve-out `meta/` uses. It is invoked explicitly by the reversibility test
-- via psql on the migration's SQL content, not via the runner.
--
-- PRECONDITION: this rollback FAILS while any actor-scoped rows exist. The
-- re-created `integrations_ws_provider_null_external_uniq` is unique on
-- (workspace_id, provider) alone, so two actors holding credentials for the
-- same provider in one workspace - precisely the state 0065 exists to
-- allow - violate it. Before rolling back, an operator must decide what
-- happens to those rows (delete them, or keep one per workspace); there is
-- no correct automatic answer, so this file deliberately does not choose.
-- Run it inside a transaction so a failure here leaves the DROPs below
-- rolled back rather than the table carrying no unique guard at all.

DROP INDEX IF EXISTS "integrations_ws_provider_idx";
DROP INDEX IF EXISTS "integrations_ws_actor_provider_null_external_uniq";
DROP INDEX IF EXISTS "integrations_ws_actor_provider_external_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_provider_external_uniq"
	ON "integrations" ("workspace_id", "provider", "external_id")
	WHERE "external_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_ws_provider_null_external_uniq"
	ON "integrations" ("workspace_id", "provider")
	WHERE "external_id" IS NULL;

ALTER TABLE "integrations" DROP COLUMN IF EXISTS "actor_id";
