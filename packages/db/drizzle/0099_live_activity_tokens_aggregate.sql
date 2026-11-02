-- Migration: live activity update tokens belong to the aggregate "Agents working" activity, one
-- per (device, workspace), not to a session. Per-session update tokens are meaningless under the
-- new design (and the app deletes/re-registers its own), so they are dropped.
-- live_activity_tokens is a small, non-hot table: plain DDL is fine. Idempotent.

DELETE FROM "live_activity_tokens" WHERE "kind" = 'update';
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" DROP CONSTRAINT IF EXISTS "live_activity_tokens_kind_session_chk";
--> statement-breakpoint
DROP INDEX IF EXISTS "live_activity_tokens_update_uniq";
--> statement-breakpoint
DROP INDEX IF EXISTS "live_activity_tokens_session_idx";
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" DROP COLUMN IF EXISTS "session_id";
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD COLUMN IF NOT EXISTS "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" DROP CONSTRAINT IF EXISTS "live_activity_tokens_kind_workspace_chk";
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD CONSTRAINT "live_activity_tokens_kind_workspace_chk" CHECK (
	("kind" = 'push_to_start' AND "workspace_id" IS NULL)
	OR ("kind" = 'update' AND "workspace_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_update_uniq"
	ON "live_activity_tokens" USING btree ("device_id", "token") WHERE "kind" = 'update';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_tokens_workspace_idx"
	ON "live_activity_tokens" USING btree ("workspace_id", "actor_id");
