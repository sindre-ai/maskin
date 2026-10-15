-- Rollback for 0083_revoke_anon_authenticated_public_grants.sql. Restores the
-- Supabase default: ALL on every table and sequence in "public" for "anon" and
-- "authenticated", plus the matching default privileges. Lives under
-- drizzle/down/ so the forward migration runner never picks it up.
--
-- Running this re-opens the exposure the forward migration closed. Only run it
-- if the app turns out to reach Postgres as one of these roles.
DO $$
DECLARE
	grantee text;
	definer text;
BEGIN
	FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee);

		EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA public TO %I', grantee);
		EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO %I', grantee);

		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO %I', grantee);
		EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO %I', grantee);

		FOREACH definer IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
			CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = definer);
			BEGIN
				EXECUTE format(
					'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON TABLES TO %I',
					definer, grantee
				);
				EXECUTE format(
					'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ALL ON SEQUENCES TO %I',
					definer, grantee
				);
			EXCEPTION WHEN insufficient_privilege THEN
				RAISE NOTICE 'skipped default privileges for role % (migration role is not a member)', definer;
			END;
		END LOOP;
	END LOOP;
END $$;
