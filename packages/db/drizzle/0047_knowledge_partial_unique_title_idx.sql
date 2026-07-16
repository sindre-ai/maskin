-- DB-side backstop for the write-time knowledge dedup check in
-- apps/dev/src/lib/knowledge-dedup.ts. The route-level `findKnowledgeDuplicate`
-- runs before the INSERT and catches exact + containment overlaps with a
-- friendly 409, but two concurrent POSTs with the same title can both pass the
-- preflight and reach the insert (classic check-then-act TOCTOU). This partial
-- unique index gives Postgres the last word so at most one live knowledge row
-- can share a normalized title within a workspace.
--
-- Normalization mirrors normalizeTitle(): trim, lowercase, collapse internal
-- whitespace to a single space. Kept as an expression index so the schema
-- doesn't need a materialized `normalized_title` column and future backfills.
--
-- Predicate matches RETIRED_KNOWLEDGE_STATUSES in knowledge-dedup.ts —
-- archived/deprecated rows do not block a fresh live entry with the same
-- title, which mirrors the runtime filter.
--
-- Precondition: the workspace has no existing live-knowledge title collisions.
-- The route-level check has been shipping, and T3's scheduled corpus-lint skill
-- reconciles historical dupes; if a target workspace still holds one, CREATE
-- INDEX will error and the migration author must resolve the offending row
-- (archive one, or link with a `duplicates` relationship) before re-running.
--
-- `CREATE INDEX CONCURRENTLY` per packages/db/MIGRATIONS.md Rule 1: kept as
-- the only statement in this file so no future edit can wrap it in a BEGIN
-- and silently leave an INVALID index behind. `IF NOT EXISTS` makes a retry
-- safe if a previous CONCURRENTLY build was interrupted.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "objects_ws_knowledge_title_unique_idx"
	ON "objects" ("workspace_id", (regexp_replace(trim(lower("title")), '\s+', ' ', 'g')))
	WHERE "type" = 'knowledge' AND "status" NOT IN ('archived', 'deprecated');
