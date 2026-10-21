-- Keychain chat capture undo (bet d46bb7f2, PR #2). Undo zeroises a vaulted key:
-- credentials and dek_ciphertext are set NULL and the row is kept so the audit
-- chain keeps its foreign key. credentials was NOT NULL, so the column is relaxed.
--
-- Relaxing NOT NULL is additive for every existing row (none is NULL) and every
-- existing writer. The CHECK keeps the relaxation narrow: a NULL is only legal on
-- an undone row, so a bug elsewhere cannot quietly park a credential-less active
-- row. dek_ciphertext has been nullable since 0087.
--
-- Readers: getCredential refuses an undone row before it reads credentials, and the
-- direct decrypt(row.credentials) sites skip a NULL. Both ship in the same PR.
-- integrations is not on the hot-tables list (packages/db/MIGRATIONS.md).
-- Down: drizzle/down/0088_integrations_credentials_nullable_down.sql.

ALTER TABLE "integrations" ALTER COLUMN "credentials" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_credentials_null_only_when_undone"
	CHECK ("credentials" IS NOT NULL OR "status" = 'undone');
