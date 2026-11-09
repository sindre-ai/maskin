-- Turn on row-level security for "oauth_grants", "oauth_authorization_codes",
-- "oauth_tokens", "saved_views" and "live_activity_follows".
--
-- Supabase's security advisor flags all five: with RLS off, anyone holding the public
-- client key could in principle read or change them. Nobody can today, because
-- "anon" and "authenticated" hold no grants on them, so this is a second lock.
-- The tables were created by 0092, 0138 and 0140, after the blanket pass in 0111.
--
-- No policy is added, so "anon" and "authenticated" are denied by default, as for
-- every other table after 0111. The app is not affected: it connects as the table
-- owner, which bypasses row security unless FORCE ROW LEVEL SECURITY is set. This
-- migration never sets FORCE, and grants are not touched. None of the five tables
-- is read through the public client key or the REST endpoint.
--
-- Locking: ENABLE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE, which is instant on
-- its own but queues behind any open transaction. None of the five is on the hot
-- tables list in MIGRATIONS.md, so a plain ALTER with a 5s lock_timeout is enough:
-- if a table is busy the migration fails fast instead of stalling writes, and
-- re-running it is safe. ENABLE is a no-op on a table that already has RLS on.
--
-- Reversible: drizzle/down/0141_enable_rls_oauth_saved_views_live_activity_down.sql.
-- Only table flags change; no rows, columns or grants are touched.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "oauth_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saved_views" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "live_activity_follows" ENABLE ROW LEVEL SECURITY;
