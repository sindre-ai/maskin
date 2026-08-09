-- DB-side backstop that closes the loop-install TOCTOU race in
-- loop-provisioning.ts. The runtime dedup is SELECT-then-INSERT, so two
-- concurrent installs of loops that share an agent can both miss and clone
-- the actor row. This partial unique index gives Postgres the last word: at
-- most one actor row per workspace can claim a given source_item_id.
--
-- Partial predicate on "(workspace_id) IS NOT NULL" keeps every pre-existing
-- row (signup actors, workspace-created agents — all workspace_id NULL) out
-- of the index entirely. The column was only added by migration 0052, so the
-- index indexes nothing at creation and needs no duplicate-row cleanup — the
-- bet's "no backfill of historical duplicates" scope holds.
--
-- Expression index on metadata->>'source_item_id', the same metadata key the
-- runtime dedup lookup parameterizes on.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: kept as the
-- only statement in this file so no future edit can wrap it in a BEGIN and
-- silently leave an INVALID index behind. IF NOT EXISTS makes a retry safe if
-- a previous CONCURRENTLY build was interrupted.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "actors_ws_source_item_uniq"
	ON "actors" ("workspace_id", ((metadata->>'source_item_id')))
	WHERE "workspace_id" IS NOT NULL;