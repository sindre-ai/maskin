-- P0 security: the Supabase-managed "anon" and "authenticated" roles hold
-- grants on every table and sequence in "public", and RLS is off on all of
-- them. If the Supabase Data API (PostgREST) serves "public", the publishable
-- anon key can read and write every table. Nothing in this repo uses the anon
-- key or supabase-js; the app reaches Postgres directly through
-- DATABASE_URL_DIRECT / POSTGRES_URL.
--
-- This revokes all table and sequence privileges in "public" from both roles,
-- and stops future tables from being granted to them by default. It does not
-- touch "service_role" (server-side only, bypasses RLS) or schema USAGE.
--
-- Plain Postgres (local dev, CI, self-hosted) has no "anon" / "authenticated"
-- roles, so every step is skipped for a role that does not exist. The default
-- privilege rules for "postgres" and "supabase_admin" need membership in those
-- roles; where the migration role lacks it the rule is skipped with a NOTICE
-- instead of failing the migration.
--
-- Reversible by GRANT: drizzle/down/0083_revoke_anon_authenticated_public_grants_down.sql.
-- Only roles and privileges change; no rows or columns are touched.
DO $$
DECLARE
	grantee text;
	definer text;
BEGIN
	FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);

		EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', grantee);
		EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', grantee);

		-- Default privileges for objects the migration role creates from now on.
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', grantee);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', grantee);

		-- Default privileges for objects the Supabase admin roles create.
		FOREACH definer IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
			CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = definer);
			BEGIN
				EXECUTE format(
					'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
					definer, grantee
				);
				EXECUTE format(
					'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
					definer, grantee
				);
			EXCEPTION WHEN insufficient_privilege THEN
				RAISE NOTICE 'skipped default privileges for role % (migration role is not a member)', definer;
			END;
		END LOOP;
	END LOOP;
END $$;
