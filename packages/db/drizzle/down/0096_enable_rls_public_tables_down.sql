-- Rollback for 0096_enable_rls_public_tables.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Turns row-level security back off on every table in "public". Grants stay as
-- 0083 left them (anon and authenticated hold none). Same per-table
-- transaction and lock_timeout as the forward migration; re-run if a table
-- was busy.
CREATE OR REPLACE PROCEDURE disable_rls_public_tables()
LANGUAGE plpgsql AS $$
DECLARE
	tbl text;
	tbls text[];
BEGIN
	SELECT array_agg(c.relname ORDER BY c.relname) INTO tbls
	FROM pg_class c
	JOIN pg_namespace n ON n.oid = c.relnamespace
	WHERE n.nspname = 'public'
		AND c.relkind IN ('r', 'p')
		AND c.relrowsecurity;

	FOREACH tbl IN ARRAY COALESCE(tbls, ARRAY[]::text[]) LOOP
		SET LOCAL lock_timeout = '5s';
		EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tbl);
		COMMIT;
	END LOOP;
END $$;
--> statement-breakpoint
CALL disable_rls_public_tables();
--> statement-breakpoint
DROP PROCEDURE disable_rls_public_tables();
