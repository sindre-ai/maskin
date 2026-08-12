CREATE TABLE "consumed_nonce" (
	"nonce" text PRIMARY KEY NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_blob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"meeting_id" text NOT NULL,
	"field" text NOT NULL,
	"logical_clock" bigint NOT NULL,
	"payload" text NOT NULL,
	"server_seq" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_blob_server_seq_unique" UNIQUE("server_seq")
);
