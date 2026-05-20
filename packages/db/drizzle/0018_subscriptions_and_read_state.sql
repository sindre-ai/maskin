-- Polymorphic subscriptions + per-actor read state.
--
-- Both tables key on (actor_id, entity_type, entity_id). v1 only stores
-- entity_type='object', but the schema is intentionally entity-generic so
-- threads, sessions, etc. can become subscribable later without migrations.
--
-- read_state.last_read_event_id references events.id (bigint) but there is
-- no FK because events are rarely deleted and the entity may eventually be
-- something other than object. Unread is computed as:
--   events WHERE entity_type = … AND entity_id = … AND action = 'commented'
--          AND id > coalesce(last_read_event_id, 0)
--          AND actor_id <> <viewer>      -- don't count your own activity.

CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "subscriptions_source_check" CHECK ("source" IN ('manual', 'author', 'commenter')),
	CONSTRAINT "subscriptions_actor_entity_uniq" UNIQUE ("actor_id", "entity_type", "entity_id")
);

CREATE INDEX IF NOT EXISTS "subscriptions_ws_actor_idx"
	ON "subscriptions" ("workspace_id", "actor_id");

CREATE INDEX IF NOT EXISTS "subscriptions_entity_idx"
	ON "subscriptions" ("entity_type", "entity_id");

CREATE TABLE IF NOT EXISTS "read_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"last_read_event_id" bigint NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "read_state_actor_entity_uniq" UNIQUE ("actor_id", "entity_type", "entity_id")
);

CREATE INDEX IF NOT EXISTS "read_state_ws_actor_idx"
	ON "read_state" ("workspace_id", "actor_id");
