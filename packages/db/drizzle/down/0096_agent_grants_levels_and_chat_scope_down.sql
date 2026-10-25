-- Rollback for 0096. Drops the chat-scoped grants and the explicit 'none' rows (they would
-- violate the old CHECK), and restores the old level set. A write that became read_write
-- stays read_write: the original level is not kept.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "agent_chat_grants";
--> statement-breakpoint
DELETE FROM "agent_grants" WHERE "access" = 'none';
--> statement-breakpoint
ALTER TABLE "agent_grants" DROP CONSTRAINT IF EXISTS "agent_grants_access_enum";
--> statement-breakpoint
ALTER TABLE "agent_grants"
	ADD CONSTRAINT "agent_grants_access_enum" CHECK ("access" IN ('read', 'write', 'read_write'));
