-- Rollback for 0095_revoke_function_default_execute.sql. Restores the Supabase
-- and Postgres defaults: EXECUTE on new functions for anon and authenticated
-- in "public", and for PUBLIC. Lives under drizzle/down/ so the forward
-- migration runner never picks it up.
--
-- Running this re-opens the exposure the forward migration closed: every
-- function created afterwards is callable through /rest/v1/rpc by anon.
DO $$
DECLARE
	grantee text;
	definer text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		RETURN;
	END IF;

	FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I', grantee);
	END LOOP;
	ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;

	IF current_user <> 'postgres' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
		definer := 'postgres';
		BEGIN
			FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
				CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);
				EXECUTE format(
					'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO %I',
					definer, grantee
				);
			END LOOP;
			EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT EXECUTE ON FUNCTIONS TO PUBLIC', definer);
		EXCEPTION WHEN insufficient_privilege THEN
			RAISE NOTICE 'skipped default privileges for role % (migration role is not a member)', definer;
		END;
	END IF;
END $$;
