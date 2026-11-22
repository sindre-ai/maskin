-- Migration: password_reset_tokens — one-time "Forgot password" links. Only the SHA-256 of the
-- token is stored. Rows cascade with the actor. New table, not hot-listed: plain CREATE INDEX is
-- fine. No triggers / pg_notify. Idempotent — safe to re-run.
-- Down: drizzle/down/0152_password_reset_tokens_down.sql.

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_reset_tokens_actor_idx" ON "password_reset_tokens" USING btree ("actor_id");
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
