-- R11-A · Fan-out registration foundation.
--
-- Adds the `unipile_acc_slug` column that names a connected LinkedIn account
-- in the per-identity MCP instance slug `linkedin-{unipile_acc_slug}-{identity_slug}`.
-- The value is `unipileClient.getProfile({ identifier: 'me' }).public_identifier`,
-- resolved once at connect-time (or by the admin refresh-identities endpoint)
-- and treated as immutable per credential. See linkedin-mcp-phase2-technical-spec.md §1.3 + §1.6.
--
-- The column is nullable on purpose. Phase 1 rows that connected before R11
-- don't have a slug; they get filled the next time the credential refreshes
-- (Unipile `account.updated` webhook or the admin refresh-identities call).
-- Other providers (`slack`, `gmail`, `github`, …) ignore the column entirely.
--
-- The partial index answers "look up integrations by unipile_acc_slug" without
-- indexing the many NULL rows for other providers.

ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "unipile_acc_slug" text;

CREATE INDEX IF NOT EXISTS "integrations_unipile_acc_slug_idx"
	ON "integrations" ("unipile_acc_slug")
	WHERE "unipile_acc_slug" IS NOT NULL;
