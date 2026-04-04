ALTER TABLE "actors" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "last_fired_at" timestamp with time zone;