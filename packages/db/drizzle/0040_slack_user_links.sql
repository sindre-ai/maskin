-- Routes one (Slack team, Slack user) → the right Maskin actor + default
-- workspace. Closes the multi-workspace OAuth gap from insight ins4: a Slack
-- user may belong to several Maskin workspaces, and the per-workspace
-- `integrations` row alone cannot answer "which workspace should @Maskin's
-- reply land in?". This link table is consulted by the Slack route on every
-- mention (T3+) to resolve the acting Maskin actor.
--
-- Composite PK on (slack_team_id, slack_user_id) keeps it cheap to upsert on
-- account-link and to read on each webhook. Both FKs CASCADE so deleting the
-- Maskin actor or workspace reaps the link rows; AC-T5 (Slack disconnect)
-- separately reaps rows by (team, user) before the integration is revoked.
--
-- Additive: this migration only creates a new table. No `integrations` row
-- is read, modified, or referenced — satisfying AC-T4.

CREATE TABLE IF NOT EXISTS "slack_user_links" (
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"default_workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_links_pk" PRIMARY KEY ("slack_team_id", "slack_user_id")
);

ALTER TABLE "slack_user_links"
	DROP CONSTRAINT IF EXISTS "slack_user_links_actor_id_actors_id_fk";
ALTER TABLE "slack_user_links"
	ADD CONSTRAINT "slack_user_links_actor_id_actors_id_fk"
	FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id")
	ON DELETE cascade ON UPDATE no action;

ALTER TABLE "slack_user_links"
	DROP CONSTRAINT IF EXISTS "slack_user_links_default_workspace_id_workspaces_id_fk";
ALTER TABLE "slack_user_links"
	ADD CONSTRAINT "slack_user_links_default_workspace_id_workspaces_id_fk"
	FOREIGN KEY ("default_workspace_id") REFERENCES "public"."workspaces"("id")
	ON DELETE cascade ON UPDATE no action;

-- ROLLBACK
-- The migrator (packages/db/src/migrate.ts) blindly applies every *.sql file
-- in this directory in alphabetical order, so adding a separate
-- 00XX_rollback_slack_user_links.sql would auto-undo this migration on the
-- next deploy. Run the statements below manually (or copy into a fresh
-- numbered migration if you really want them in the timeline) to drop the
-- table. They touch nothing else — the `integrations` table is untouched.
--
-- DROP TABLE IF EXISTS "slack_user_links";
