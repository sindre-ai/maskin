-- Rollback for 0121_enable_rls_extensions_blocked_tool_calls.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Turns row-level security back off on the two tables. Grants stay as 0083 left
-- them (anon and authenticated hold none).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE IF EXISTS "blocked_tool_calls" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE IF EXISTS "extensions" DISABLE ROW LEVEL SECURITY;
