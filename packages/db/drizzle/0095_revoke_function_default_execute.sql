-- Security follow-up to 0083. The Supabase Data API serves "public", so any
-- function created there is callable as /rest/v1/rpc/<name> by the anon and
-- authenticated roles unless EXECUTE is withheld. Today new functions get
-- EXECUTE from two places: the schema default privileges for "postgres"
-- (anon, authenticated, service_role) and the Postgres built-in default that
-- gives PUBLIC EXECUTE on every new function. Anon and authenticated inherit
-- PUBLIC, so both have to go.
--
-- This migration:
--   1. revokes the "public" schema default EXECUTE on functions from anon and
--      authenticated, for the migration role and for "postgres";
--   2. revokes the built-in PUBLIC default EXECUTE on functions for the
--      migration role and for "postgres" (database-wide, not schema scoped:
--      a schema-scoped default can only add privileges, never remove PUBLIC's).
--
-- service_role keeps its schema default EXECUTE, and owners always keep
-- EXECUTE on their own functions. A function that must be callable through the
-- Data API has to be granted explicitly in the migration that creates it.
--
-- Not touched: existing functions (their ACLs are unchanged), and the
-- supabase_admin default privileges (the migration role cannot alter another
-- role's defaults; out of scope per the CTO).
--
-- Plain Postgres (local dev, CI, self-hosted) has no "anon" role, so every
-- step is skipped there.
--
-- Reversible by GRANT: drizzle/down/0095_revoke_function_default_execute_down.sql.
-- Only default privileges change; no function, table or row is touched.
DO $$
DECLARE
	grantee text;
	definer text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		RETURN;
	END IF;

	-- Default privileges for functions the migration role creates from now on.
	FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', grantee);
	END LOOP;
	ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

	-- Same for "postgres" when the migration role is a different role.
	IF current_user <> 'postgres' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
		definer := 'postgres';
		BEGIN
			FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
				CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);
				EXECUTE format(
					'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I',
					definer, grantee
				);
			END LOOP;
			EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', definer);
		EXCEPTION WHEN insufficient_privilege THEN
			RAISE NOTICE 'skipped default privileges for role % (migration role is not a member)', definer;
		END;
	END IF;
END $$;
