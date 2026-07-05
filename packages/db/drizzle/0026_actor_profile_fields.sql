ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "bio" text;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "avatar_storage_key" text;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "pending_email" text;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "pending_email_token" text;--> statement-breakpoint
ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "pending_email_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actors_pending_email_token_uniq" ON "actors" USING btree ("pending_email_token") WHERE "pending_email_token" IS NOT NULL;
