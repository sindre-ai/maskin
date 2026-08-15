-- Stores APNs device tokens for the iOS Tauri shell so the backend can send
-- push notifications to a specific device once actionable pushes are wired
-- (bet maskin-mobile-app). Written by PATCH /api/apns-tokens on every launch
-- of the shell; the client re-registers unconditionally so a rotated token
-- (Apple can silently invalidate one) heals on the next foreground.
--
-- Keyed by token: a single physical device holds one APNs token at a time,
-- and a token uniquely identifies a device + bundle-id + environment triple.
-- If the same device is signed in as a new actor after sign-out, the upsert
-- reassigns actor_id to the new owner, so we never push the old actor's
-- notifications to the new session on that device.
--
-- Not workspace-scoped: a Maskin actor participates in many workspaces from
-- the same device, and APNs delivery is per device, not per workspace. The
-- server-side push sender (follow-up task) will target rows by actor_id.

CREATE TABLE IF NOT EXISTS "apns_device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apns_device_tokens_token_uniq" UNIQUE ("token"),
	CONSTRAINT "apns_device_tokens_environment_check"
		CHECK ("environment" IN ('sandbox', 'production'))
);

ALTER TABLE "apns_device_tokens"
	DROP CONSTRAINT IF EXISTS "apns_device_tokens_actor_id_actors_id_fk";
ALTER TABLE "apns_device_tokens"
	ADD CONSTRAINT "apns_device_tokens_actor_id_actors_id_fk"
	FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id")
	ON DELETE cascade ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "apns_device_tokens_actor_id_idx"
	ON "apns_device_tokens" USING btree ("actor_id");

-- ROLLBACK
-- The migrator applies every *.sql in this directory in order; a separate
-- rollback file here would auto-undo the migration on the next deploy. Run
-- the statements below by hand (or in a fresh numbered migration) to drop
-- the table:
--
-- DROP TABLE IF EXISTS "apns_device_tokens";
