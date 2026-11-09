-- Migration: live_activity_follows — the runs a person chose to follow from an agent's working
-- banner (the opt-in "Following an agent" Live Activity). The app starts the card itself with
-- ActivityKit and registers the card's own push token here, so the backend can send it the agent's
-- latest step and its end. One row per device and session; stopping or finishing deletes the row.
-- New table, not hot-listed: plain CREATE INDEX is fine. Rows cascade with the actor, device,
-- workspace and session. No triggers / pg_notify. Idempotent — safe to re-run.
-- Down: drizzle/down/0138_live_activity_follows_down.sql.

CREATE TABLE IF NOT EXISTS "live_activity_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"device_id" uuid NOT NULL REFERENCES "device_tokens"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_follows_device_session_uniq" ON "live_activity_follows" USING btree ("device_id", "session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_follows_workspace_idx" ON "live_activity_follows" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_follows_actor_idx" ON "live_activity_follows" USING btree ("actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_follows_session_idx" ON "live_activity_follows" USING btree ("session_id");
