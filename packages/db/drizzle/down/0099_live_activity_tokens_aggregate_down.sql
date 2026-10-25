-- Rollback for 0099_live_activity_tokens_aggregate.sql. Update tokens are deleted (their
-- shape changes); the app re-registers them on its next launch.
DELETE FROM "live_activity_tokens" WHERE "kind" = 'update';
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" DROP CONSTRAINT IF EXISTS "live_activity_tokens_kind_workspace_chk";
--> statement-breakpoint
DROP INDEX IF EXISTS "live_activity_tokens_update_uniq";
--> statement-breakpoint
DROP INDEX IF EXISTS "live_activity_tokens_workspace_idx";
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" DROP COLUMN IF EXISTS "workspace_id";
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD COLUMN IF NOT EXISTS "session_id" uuid REFERENCES "sessions"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD CONSTRAINT "live_activity_tokens_kind_session_chk" CHECK (
	("kind" = 'push_to_start' AND "session_id" IS NULL)
	OR ("kind" = 'update' AND "session_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_update_uniq"
	ON "live_activity_tokens" USING btree ("device_id", "session_id") WHERE "kind" = 'update';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_activity_tokens_session_idx" ON "live_activity_tokens" USING btree ("session_id");
