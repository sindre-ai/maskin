-- Workspace browser: the auth-browser container now survives past cookie
-- capture so agent sessions can drive it via CDP. Adds idle-tracking columns
-- and broadens the unique index to (workspace_id, provider) covering the new
-- 'idle' and 'driving' statuses.

ALTER TABLE "auth_browser_sessions"
	ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE "auth_browser_sessions"
	ADD COLUMN IF NOT EXISTS "claimed_by_session_id" uuid REFERENCES "sessions"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_browser_sessions_activity_idx"
	ON "auth_browser_sessions" ("last_activity_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "auth_browser_sessions_ws_active_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_browser_sessions_ws_provider_active_uniq"
	ON "auth_browser_sessions" ("workspace_id", "provider")
	WHERE status IN ('starting', 'ready', 'idle', 'driving');
