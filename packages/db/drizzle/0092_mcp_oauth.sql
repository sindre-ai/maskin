-- OAuth for the MCP server (Claude connector). Three brand-new, empty tables:
--   oauth_grants              one row per consent: actor x workspace x client. The unit of revocation.
--   oauth_authorization_codes one row per issued code. Single use, 60 seconds.
--   oauth_tokens              access and refresh tokens.
-- Tokens and codes are stored as SHA-256 hex only. A raw mat_ / mrt_ value or a raw
-- code never reaches a column. No expires_at on oauth_grants: a grant lives until it is
-- revoked or its refresh token goes unused for 30 days (the refresh token carries that).
--
-- Additive-only expand step. None of these tables is on the hot-table list in
-- packages/db/MIGRATIONS.md and they hold no rows yet, so plain CREATE INDEX is fine.
-- Nothing reads or writes them until a later task ships the token endpoint.

CREATE TABLE IF NOT EXISTS "oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"scope" text DEFAULT 'mcp' NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_actor_id" uuid,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"replaced_by" uuid,
	CONSTRAINT "oauth_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_tokens_kind_check" CHECK ("kind" in ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "oauth_grants"
	DROP CONSTRAINT IF EXISTS "oauth_grants_actor_id_actors_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_grants"
	ADD CONSTRAINT "oauth_grants_actor_id_actors_id_fk"
	FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_grants"
	DROP CONSTRAINT IF EXISTS "oauth_grants_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_grants"
	ADD CONSTRAINT "oauth_grants_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_grants"
	DROP CONSTRAINT IF EXISTS "oauth_grants_revoked_by_actor_id_actors_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_grants"
	ADD CONSTRAINT "oauth_grants_revoked_by_actor_id_actors_id_fk"
	FOREIGN KEY ("revoked_by_actor_id") REFERENCES "public"."actors"("id")
	ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes"
	DROP CONSTRAINT IF EXISTS "oauth_authorization_codes_grant_id_oauth_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes"
	ADD CONSTRAINT "oauth_authorization_codes_grant_id_oauth_grants_id_fk"
	FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_tokens"
	DROP CONSTRAINT IF EXISTS "oauth_tokens_grant_id_oauth_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_tokens"
	ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk"
	FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id")
	ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "oauth_tokens"
	DROP CONSTRAINT IF EXISTS "oauth_tokens_replaced_by_oauth_tokens_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_tokens"
	ADD CONSTRAINT "oauth_tokens_replaced_by_oauth_tokens_id_fk"
	FOREIGN KEY ("replaced_by") REFERENCES "public"."oauth_tokens"("id")
	ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_grants_live_uniq"
	ON "oauth_grants" ("actor_id", "workspace_id", "client_id")
	WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_grants_workspace_live_idx"
	ON "oauth_grants" ("workspace_id")
	WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_grant_idx"
	ON "oauth_authorization_codes" ("grant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_codes_expires_at_idx"
	ON "oauth_authorization_codes" ("expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_grant_idx"
	ON "oauth_tokens" ("grant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_expires_at_idx"
	ON "oauth_tokens" ("expires_at");
