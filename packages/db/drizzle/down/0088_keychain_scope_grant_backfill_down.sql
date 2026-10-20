-- Rollback for 0088_keychain_scope_grant_backfill.sql. Puts google-meet and
-- linkedin-unipile rows whose grants are exactly one workspace grant back to the
-- empty array. A row an admin deliberately set to a lone workspace grant is
-- indistinguishable from a backfilled one and is reset too, so roll back only
-- before anyone has edited grants by hand.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE "integrations"
SET "scope_grants" = '[]'::jsonb
WHERE "provider" IN ('google-meet', 'linkedin-unipile')
	AND "scope_grants" = '[{"kind":"workspace"}]'::jsonb;
