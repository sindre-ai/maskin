-- Rollback for 0167_enable_rls_ai_usage_trial_tables.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Turns row-level security back off on the three tables. Grants stay as they were
-- (anon and authenticated hold none).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trial_cards" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_ai_usage" DISABLE ROW LEVEL SECURITY;
