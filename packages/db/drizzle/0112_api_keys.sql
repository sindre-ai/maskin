-- Hashed API keys, step one of expand / migrate / contract (task: hash API keys at rest).
--
-- 1. api_keys holds the SHA-256 (hex) of every key. One actor can hold many: a primary key, one
--    per login, one per agent session launch. Session keys cascade away with their session.
-- 2. Every existing ank_ key is backfilled as that actor's primary key, hashed with the built-in
--    sha256 (Postgres 11+, so Supabase 17 and the compose Postgres 16 both have it). No key is
--    rotated: whatever a person or tool holds today keeps authenticating.
-- 3. last_used_at is stamped when a key is looked up (at most once per auth cache window), so the
--    contract step can tell which backfilled agent keys are still used outside Maskin.
-- 4. actors.api_key stays, now nullable and no longer written. Readers move to api_keys in the
--    same release; a later migration empties the column once this one has run in prod.
--
-- actors is not on the hot-tables list (docs: MIGRATIONS.md) and holds a few thousand rows, so the
-- backfill is one statement rather than the chunked recipe. Non-ank_ values (the landing guest
-- placeholder, deleted_ tombstones) never authenticate and are skipped.
-- Row-level security is switched on for api_keys here because 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0112_api_keys_down.sql.

CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"key_hash" text NOT NULL,
	"last4" text NOT NULL,
	"kind" text NOT NULL,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE ("key_hash"),
	CONSTRAINT "api_keys_kind_enum" CHECK ("kind" IN ('primary', 'login', 'login_ios', 'session'))
);
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_actor_kind_idx" ON "api_keys" ("actor_id", "kind");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_session_idx" ON "api_keys" ("session_id") WHERE "session_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "actors" ALTER COLUMN "api_key" DROP NOT NULL;
--> statement-breakpoint
INSERT INTO "api_keys" ("actor_id", "key_hash", "last4", "kind")
SELECT "id", encode(sha256(convert_to("api_key", 'UTF8')), 'hex'), right("api_key", 4), 'primary'
FROM "actors"
WHERE left("api_key", 4) = 'ank_'
ON CONFLICT ("key_hash") DO NOTHING;
