-- Defence in depth for the anon-key incident: turn on row-level security on
-- every table in "public", so "anon" and "authenticated" are denied by default.
-- Migration 0083 already revoked their grants; this adds the second barrier so
-- a future accidental GRANT does not expose rows.
--
-- The app is not affected: it connects as the table owner ("postgres" in
-- prod, which also has BYPASSRLS), and an owner bypasses row security unless
-- FORCE ROW LEVEL SECURITY is set. This migration never sets FORCE.
--
-- One policy exists, on purpose: the Keychain writes its audit rows as the
-- non-owner role maskin_keychain_app (0087, SET LOCAL ROLE inside
-- getCredential). A non-owner is subject to row security, so without a policy
-- every credential read would fail on the audit insert. The policy is scoped
-- TO that role only; what the role can do is still limited by its grants
-- (SELECT and INSERT on credential_access_log, nothing else). No other table
-- gets a policy.
--
-- Numbered 0111, after every table that exists today: the runner applies any
-- unapplied file in name order, so a lower number would run before the later
-- migrations that create tables and leave those without row security on a
-- fresh database.
--
-- Locking: ENABLE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE, which is instant
-- on its own but queues behind any open transaction on the table and then
-- blocks everyone behind it (hot tables: see MIGRATIONS.md). So each table is
-- altered in its own transaction (a procedure that COMMITs per table, as in
-- MIGRATIONS.md Rule 2) with a 5s lock_timeout. If a table is busy the
-- migration fails fast instead of stalling writes; re-running it finishes the
-- remaining tables, because tables that already have RLS on are skipped.
--
-- Loops over pg_class instead of listing tables, so it covers every table
-- that exists when it runs (including "_migrations") and needs no upkeep.
-- Plain Postgres (local dev, CI, self-hosted) runs it unchanged.
--
-- Reversible: drizzle/down/0111_enable_rls_public_tables_down.sql.
-- Only table flags and one policy change; no rows, columns or grants are touched.
CREATE OR REPLACE PROCEDURE enable_rls_public_tables()
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
		AND NOT c.relrowsecurity;

	FOREACH tbl IN ARRAY COALESCE(tbls, ARRAY[]::text[]) LOOP
		SET LOCAL lock_timeout = '5s';
		EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
		COMMIT;
	END LOOP;
END $$;
--> statement-breakpoint
CALL enable_rls_public_tables();
--> statement-breakpoint
DROP PROCEDURE enable_rls_public_tables();
--> statement-breakpoint
DROP POLICY IF EXISTS "credential_access_log_keychain_app" ON "credential_access_log";
--> statement-breakpoint
CREATE POLICY "credential_access_log_keychain_app" ON "credential_access_log"
	FOR ALL TO maskin_keychain_app USING (true) WITH CHECK (true);
