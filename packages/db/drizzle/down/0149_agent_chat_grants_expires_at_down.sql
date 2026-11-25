-- Rollback for 0149. Drops the expiry. A chat grant on a built-in integration then has no end,
-- so remove those rows first: Keychain chat grants (expires_at IS NULL) are left as they are.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DELETE FROM "agent_chat_grants" WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_chat_grants" DROP COLUMN IF EXISTS "expires_at";
