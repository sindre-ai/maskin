-- Migration: live_activity_tokens — ActivityKit push tokens (push-to-start per device,
-- update token per running activity tied to a session).
-- New table, not hot-listed: plain CREATE INDEX is fine. Rows cascade with the
-- device, actor and (for update tokens) the session. No triggers / pg_notify.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "live_activity_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"device_id" uuid NOT NULL REFERENCES "device_tokens"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_activity_tokens_kind_session_chk" CHECK (
		("kind" = 'push_to_start' AND "session_id" IS NULL)
		OR ("kind" = 'update' AND "session_id" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_push_to_start_uniq"
	ON "live_activity_tokens" USING btree ("device_id") WHERE "kind" = 'push_to_start';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_update_uniq"
	ON "live_activity_tokens" USING btree ("device_id", "session_id") WHERE "kind" = 'update';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_tokens_session_idx" ON "live_activity_tokens" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_tokens_actor_idx" ON "live_activity_tokens" USING btree ("actor_id");
