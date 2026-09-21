-- Server-persisted per-actor "starred" flag on objects (D5 of the Objects v4
-- polish bet). The row's presence means starred; unstar is a row DELETE (see
-- apps/dev/src/services/star-state.ts), so no soft-flag / unstarred_at column
-- is needed and boolean semantics match the payload's `is_starred_by_me`
-- scalar 1:1. Mirrors the shape of `read_state` — polymorphic
-- (entity_type, entity_id) target so the same table can back future starrable
-- entity types (comment, session, …) without a migration; ship writes only
-- `entity_type = 'object'` rows.
--
-- Composite PK (actor_id, entity_type, entity_id) enforces "at most one star
-- per (actor, entity)" cleanly — no separate unique constraint. Two indexes
-- support the query shapes the D5 backend needs:
--   - `(workspace_id, actor_id)` for the list-hydration query (list handlers
--     issue one `SELECT entity_id FROM star_state WHERE actor_id = $1 AND
--     entity_type = 'object' AND entity_id = ANY($2::uuid[])` per page and
--     merge the result into each row as `is_starred_by_me`; see
--     apps/dev/src/services/star-state.ts).
--   - `(entity_type, entity_id)` reverse index — future "who else starred
--     this" surfaces (not consumed by this migration's code).

CREATE TABLE IF NOT EXISTS "star_state" (
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"starred_at" timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY ("actor_id", "entity_type", "entity_id")
);

CREATE INDEX IF NOT EXISTS "star_state_lookup_idx"
	ON "star_state" ("workspace_id", "actor_id");

CREATE INDEX IF NOT EXISTS "star_state_reverse_idx"
	ON "star_state" ("entity_type", "entity_id");
