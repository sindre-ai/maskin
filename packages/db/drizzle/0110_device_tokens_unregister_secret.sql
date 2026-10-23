-- Migration: device_tokens.unregister_secret_hash
-- A signed-out phone holds no API key, so it could not drop its own push registration.
-- The app now generates a per-device secret and sends it when it registers; the server keeps only
-- its SHA-256 here. POST /api/devices/unregister deletes the row when the secret matches.
-- Nullable and additive: rows registered by older clients keep a null hash and simply cannot use the
-- new route until the app registers again (it does so on every cold launch).
-- Not a hot table: a plain ALTER is fine.
-- Idempotent — safe to re-run.
-- Down: drizzle/down/0110_device_tokens_unregister_secret_down.sql.

ALTER TABLE "device_tokens" ADD COLUMN IF NOT EXISTS "unregister_secret_hash" text;
