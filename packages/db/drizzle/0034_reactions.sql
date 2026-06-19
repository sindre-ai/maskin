-- Per-actor emoji reactions on events (currently used for comments).
-- (event_id, actor_id, emoji) is unique so toggle is a single idempotent
-- insert / delete with no aggregate-by-latest read pattern.
--
-- event_id is bigint to match events.id (bigserial). No FK to events because
-- events are intentionally never deleted and we want the same shape to extend
-- to other persisted-event ids later without schema churn.
--
-- Realtime fan-out reuses the existing events → PG NOTIFY → SSE bridge: each
-- reaction add/remove writes an events row with action='reacted'/'unreacted',
-- so the existing 8KB-safe NOTIFY payload (id+ws+actor+action+entity ids
-- only — see 0006_notify_drop_data.sql) covers reactions too.

CREATE TABLE IF NOT EXISTS "reactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"event_id" bigint NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "reactions_event_actor_emoji_uniq" UNIQUE ("event_id", "actor_id", "emoji")
);

CREATE INDEX IF NOT EXISTS "reactions_event_idx" ON "reactions" ("event_id");
CREATE INDEX IF NOT EXISTS "reactions_ws_idx" ON "reactions" ("workspace_id");
