-- receipt_intakes and receipt_intake_keys: how an owner hands receipts to an accounting flow by email
-- or by a command, besides uploading in chat (task: Let owners send receipts three ways).
--
-- receipt_intakes: one row per flow object. email_token is the random part of the flow's receiving
-- address; only senders in allowed_senders are read (empty = the owner's own login email). held_count
-- and accepted_count are numbers only. day_utc and day_count are the daily cap shared by both routes.
-- receipt_intake_keys: keys for the command route. A key only adds receipt files to its one flow; the
-- route reads this table and nothing else, so it is not an actor API key. key_hash is the hex SHA-256.
--
-- Both tables are new and empty, so there is no lock to worry about and no backfill. Row-level
-- security is on because 0111_enable_rls_public_tables ran before these tables existed.
-- Down: drizzle/down/0176_receipt_intake_down.sql.
CREATE TABLE IF NOT EXISTS "receipt_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"loop_object_id" uuid NOT NULL UNIQUE REFERENCES "objects"("id") ON DELETE CASCADE,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"email_token" text NOT NULL UNIQUE,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"allowed_senders" text[] DEFAULT '{}'::text[] NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"held_count" integer DEFAULT 0 NOT NULL,
	"day_utc" text,
	"day_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipt_intakes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipt_intakes_workspace_idx" ON "receipt_intakes" USING btree ("workspace_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receipt_intake_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intake_id" uuid NOT NULL REFERENCES "receipt_intakes"("id") ON DELETE CASCADE,
	"key_hash" text NOT NULL UNIQUE,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "receipt_intake_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "receipt_intake_keys_intake_idx" ON "receipt_intake_keys" USING btree ("intake_id");
