-- P0 security hotfix: revoke Supabase anon/authenticated grants on public.
--
-- The Supabase Data API (PostgREST) is exposed for the public schema, RLS is off
-- on all public tables, and anon + authenticated hold SELECT/INSERT/UPDATE/DELETE
-- on every one of them. Anyone holding the publishable anon key can read and
-- write the whole database. The app connects over the direct postgres role
-- (BYPASSRLS) and never uses the anon key (no supabase-js, no /rest/v1 calls in
-- the repo), so removing these grants does not affect the app.
--
-- Idempotent: REVOKE is repeatable, so this is safe if the same statements were
-- already run by hand against prod. Guarded on pg_roles so it is a no-op on
-- databases that do not have the Supabase roles (local dev, CI Postgres).
--
-- Deliberately NOT in this migration (out of scope, follow-up task):
--   - ENABLE ROW LEVEL SECURITY on the public tables
--   - EXECUTE on public functions, schema USAGE
--   - ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin (the migration role
--     cannot alter another role's defaults)
--
-- Rollback (not auto-run, lives in the PR description): GRANT SELECT, INSERT,
-- UPDATE, DELETE ON ALL TABLES and GRANT USAGE, SELECT ON ALL SEQUENCES in
-- schema public TO anon, authenticated.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
		AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
		REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
		-- Defaults for objects the migration role creates in the future, so new
		-- tables do not re-open the hole.
		ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
		ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
	END IF;
END $$;
