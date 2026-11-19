-- Turn on row-level security for "workspace_ai_usage", "trial_cards" and
-- "trial_promo_codes".
--
-- Supabase's security advisor flags all three: with RLS off, anyone holding the public
-- client key could in principle read or change them ("trial_cards" holds card
-- fingerprints). Nobody can today, because "anon" and "authenticated" hold no grants
-- on them, so this is a second lock. The tables were created by 0144, 0148 and 0150,
-- after the blanket pass in 0111.
--
-- No policy is added, so "anon" and "authenticated" are denied by default, as for
-- every other table after 0111. The app is not affected: it connects as the table
-- owner, which bypasses row security unless FORCE ROW LEVEL SECURITY is set. This
-- migration never sets FORCE, and grants are not touched. None of the three tables
-- is read through the public client key or the REST endpoint (the repo has no such
-- client; every read goes through the app's own database connection).
--
-- Locking: ENABLE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE, which is instant on
-- its own but queues behind any open transaction. None of the three is on the hot
-- tables list in MIGRATIONS.md, so a plain ALTER with a 5s lock_timeout is enough:
-- if a table is busy the migration fails fast instead of stalling writes, and
-- re-running it is safe. ENABLE is a no-op on a table that already has RLS on.
--
-- Reversible: drizzle/down/0166_enable_rls_ai_usage_trial_tables_down.sql.
-- Only table flags change; no rows, columns or grants are touched.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "workspace_ai_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trial_cards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trial_promo_codes" ENABLE ROW LEVEL SECURITY;
