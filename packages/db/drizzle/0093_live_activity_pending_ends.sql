-- Migration: live_activity_pending_ends — an 'end' push that could not be sent because the
-- device had not registered the activity's update token; flushed when it registers.
-- New table, not hot-listed: plain CREATE INDEX is fine. Rows cascade with the session and
-- actor. No triggers / pg_notify. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "live_activity_pending_ends" (
	"session_id" uuid PRIMARY KEY NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"end_status" text NOT NULL,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_pending_ends_actor_idx" ON "live_activity_pending_ends" USING btree ("actor_id");
