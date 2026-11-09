-- Turn on row-level security for "extensions" and "blocked_tool_calls".
--
-- Supabase's security advisor flags both: with RLS off, anyone holding the public
-- client key could read or change them. Migrations 0092 and 0093 created the
-- tables, and the blanket pass in 0111 did not reach them on production (checked
-- 1 Nov 2026: relrowsecurity is false for both, 0 rows each on 29 Oct).
--
-- No policy is added, so "anon" and "authenticated" are denied by default, as for
-- every other table after 0111. The app is not affected: it connects as the table
-- owner, which bypasses row security unless FORCE ROW LEVEL SECURITY is set. This
-- migration never sets FORCE. Neither table is read through the public client key.
--
-- Locking: ENABLE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE, which is instant on
-- its own but queues behind any open transaction. Neither table is on the hot
-- tables list in MIGRATIONS.md (writes come from a session's guard report), and
-- both are tiny, so a plain ALTER with a 5s lock_timeout is enough: if a table is
-- busy the migration fails fast instead of stalling writes, and re-running it is
-- safe. ENABLE is a no-op on a table that already has RLS on.
--
-- Reversible: drizzle/down/0121_enable_rls_extensions_blocked_tool_calls_down.sql.
-- Only table flags change; no rows, columns or grants are touched.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE IF EXISTS "extensions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE IF EXISTS "blocked_tool_calls" ENABLE ROW LEVEL SECURITY;
