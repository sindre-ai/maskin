-- Google Meet `create_space` idempotency ledger. Backs Maskin-side dedupe for
-- the `google_meet__create_space` MCP tool (bet 947e task 824f) — the Meet
-- v2 `spaces.create` API accepts no client-side idempotency key, so a caller
-- that retries after a network blip would otherwise provision a fresh space
-- every time. Two identical calls (same workspace + same idempotency key)
-- collide on the unique index: the first row wins + stores the returned
-- `space_name`, the second finds it + returns the cached name.

CREATE TABLE IF NOT EXISTS "google_meet_space_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"idempotency_key" text NOT NULL,
	"space_name" text NOT NULL,
	"actor_id" uuid REFERENCES "actors"("id"),
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "google_meet_space_idempotency_ws_key_uniq"
	ON "google_meet_space_idempotency" ("workspace_id", "idempotency_key");

CREATE INDEX IF NOT EXISTS "google_meet_space_idempotency_created_at_idx"
	ON "google_meet_space_idempotency" ("created_at");
