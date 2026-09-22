-- Email-based workspace invites. A workspace admin creates a pending row and
-- dispatches an invite email that carries an opaque token; the invitee
-- redeems the token to attach (existing actor) or sign up + attach (new
-- actor). Only the SHA-256 of the token lives in the DB — the raw token
-- appears in the email URL and the accept path parameter, nowhere else.
-- See bet 6fe44b48-3939-4c29-80cf-533b4976601c for the shape.
--
-- Additive-only, brand-new empty table — no CONCURRENTLY/backfill dance per
-- packages/db/MIGRATIONS.md (that rule targets indexes/columns added to hot
-- tables with live traffic).

CREATE TABLE IF NOT EXISTS "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_actor_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_actor_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_actor_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "workspace_invitations"
	DROP CONSTRAINT IF EXISTS "workspace_invitations_workspace_id_workspaces_id_fk";
ALTER TABLE "workspace_invitations"
	ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workspace_invitations"
	DROP CONSTRAINT IF EXISTS "workspace_invitations_invited_by_actor_id_actors_id_fk";
ALTER TABLE "workspace_invitations"
	ADD CONSTRAINT "workspace_invitations_invited_by_actor_id_actors_id_fk"
	FOREIGN KEY ("invited_by_actor_id") REFERENCES "public"."actors"("id")
	ON DELETE restrict ON UPDATE no action;

ALTER TABLE "workspace_invitations"
	DROP CONSTRAINT IF EXISTS "workspace_invitations_accepted_by_actor_id_actors_id_fk";
ALTER TABLE "workspace_invitations"
	ADD CONSTRAINT "workspace_invitations_accepted_by_actor_id_actors_id_fk"
	FOREIGN KEY ("accepted_by_actor_id") REFERENCES "public"."actors"("id")
	ON DELETE set null ON UPDATE no action;

ALTER TABLE "workspace_invitations"
	DROP CONSTRAINT IF EXISTS "workspace_invitations_revoked_by_actor_id_actors_id_fk";
ALTER TABLE "workspace_invitations"
	ADD CONSTRAINT "workspace_invitations_revoked_by_actor_id_actors_id_fk"
	FOREIGN KEY ("revoked_by_actor_id") REFERENCES "public"."actors"("id")
	ON DELETE set null ON UPDATE no action;

CREATE INDEX IF NOT EXISTS "workspace_invitations_token_hash_idx"
	ON "workspace_invitations" ("token_hash");

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invitations_pending_ws_email_uniq"
	ON "workspace_invitations" ("workspace_id", lower("email"))
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS "workspace_invitations_workspace_status_idx"
	ON "workspace_invitations" ("workspace_id", "status");
