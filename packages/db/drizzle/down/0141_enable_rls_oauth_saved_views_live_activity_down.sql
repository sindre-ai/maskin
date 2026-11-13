-- Rollback for 0141_enable_rls_oauth_saved_views_live_activity.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Turns row-level security back off on the five tables. Grants stay as they were
-- (anon and authenticated hold none).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "live_activity_follows" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saved_views" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_tokens" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_grants" DISABLE ROW LEVEL SECURITY;
