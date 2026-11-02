-- Device sign-in codes (RFC 8628 device authorization): lets an Apple TV be signed in by a person
-- who is already signed in on a phone, with no keyboard on the TV.
--
-- A brand-new table, so there is nothing to backfill and no lock on any existing table. Code from
-- before this migration never reads or writes it. Only SHA-256 hashes of the codes are stored; rows
-- are single-use and expire within minutes (the start endpoint also sweeps long-expired rows).
CREATE TABLE IF NOT EXISTS "device_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code_hash" text NOT NULL,
	"client_source" text NOT NULL,
	"device_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "device_auth_codes_status_check" CHECK ("status" IN ('pending','approved','denied','consumed'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "device_auth_codes"
		ADD CONSTRAINT "device_auth_codes_actor_id_actors_id_fk"
		FOREIGN KEY ("actor_id") REFERENCES "actors"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_auth_codes_device_code_hash_uniq"
	ON "device_auth_codes" ("device_code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_auth_codes_user_code_hash_uniq"
	ON "device_auth_codes" ("user_code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_auth_codes_expires_at_idx"
	ON "device_auth_codes" ("expires_at");
