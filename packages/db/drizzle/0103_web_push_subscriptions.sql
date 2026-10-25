-- Migration: web_push_subscriptions — browser Web Push registration per actor
-- One row per push endpoint. Re-subscribing an endpoint as a different actor
-- moves the row (ON CONFLICT (endpoint) DO UPDATE SET actor_id) so a browser
-- that changes hands never pushes to its old owner.
-- New table, not hot-listed: plain CREATE INDEX is fine.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_push_subscriptions_endpoint_uniq" UNIQUE ("endpoint")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_push_subscriptions_actor_id_idx" ON "web_push_subscriptions" USING btree ("actor_id");
