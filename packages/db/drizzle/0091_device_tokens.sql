-- Migration: device_tokens — APNs registration per actor device
-- One row per (apns_token, environment). Re-registering a token as a different
-- actor moves the row (ON CONFLICT (apns_token, environment) DO UPDATE
-- SET actor_id) so a device that changes hands never pushes to its old owner.
-- New table, not hot-listed: plain CREATE INDEX is fine.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"platform" text NOT NULL,
	"apns_token" text NOT NULL,
	"environment" text NOT NULL,
	"app_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_tokens_apns_token_environment_uniq" UNIQUE ("apns_token", "environment")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_tokens_actor_id_idx" ON "device_tokens" USING btree ("actor_id");
