-- Migration: live_activity_cards — which (actor, workspace) pairs the backend believes have an
-- "Agents working" Live Activity card outstanding, and whether its end could not be sent yet
-- because the device had not registered the activity's update token (ActivityKit ends a card only
-- through that card's own token; push-to-start tokens can only start). Flushed when the update
-- token registers.
-- New table, not hot-listed: plain CREATE INDEX is fine. Rows cascade with the actor and
-- workspace. No triggers / pg_notify. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "live_activity_cards" (
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"end_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("actor_id", "workspace_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_cards_workspace_idx" ON "live_activity_cards" USING btree ("workspace_id");
