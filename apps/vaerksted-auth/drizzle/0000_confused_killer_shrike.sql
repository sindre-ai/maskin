CREATE TABLE "device" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid,
	"public_key" text NOT NULL,
	"platform" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "device_cert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaerksted_identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supabase_user_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaerksted_identity_supabase_user_id_unique" UNIQUE("supabase_user_id")
);
--> statement-breakpoint
ALTER TABLE "device" ADD CONSTRAINT "device_identity_id_vaerksted_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."vaerksted_identity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_cert" ADD CONSTRAINT "device_cert_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_cert" ADD CONSTRAINT "device_cert_identity_id_vaerksted_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."vaerksted_identity"("id") ON DELETE no action ON UPDATE no action;