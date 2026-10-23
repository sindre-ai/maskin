-- Keychain scope-grant backfill (bet d46bb7f2, task e4acac9a). Data only, no schema change.
--
-- 0087 added integrations.scope_grants with an empty default, and getCredential
-- fails closed on an empty list, so every row that existed before Keychain is
-- unreadable through it. This gives each such google-meet and linkedin-unipile
-- row exactly one WORKSPACE-kind grant, so the two readers can move onto
-- getCredential without changing who can use the credential today:
--   - google-meet is workspace-scoped (actor_id is NULL), so there is no actor to grant.
--   - linkedin-unipile rows carry the connecting human's actor_id, but agents
--     read them through fallbackToAnyActor, so an actor grant would deny every
--     agent read. Per-actor tightening is a later product call.
--
-- Idempotent: only rows whose scope_grants is still the empty array are touched,
-- so a second run changes nothing. Rows that already have grants, and every
-- other provider, are left alone. All statuses are covered, so a row that is
-- reconnected later is already granted.
-- Down: drizzle/down/0088_keychain_scope_grant_backfill_down.sql.

UPDATE "integrations"
SET "scope_grants" = '[{"kind":"workspace"}]'::jsonb
WHERE "provider" IN ('google-meet', 'linkedin-unipile')
	AND "scope_grants" = '[]'::jsonb;
