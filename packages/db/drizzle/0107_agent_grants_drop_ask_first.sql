-- Agent grants: "ask first" folds into read_write.
--
-- ask_first (0100) was a separate level for Gmail only: the agent could use the write tools but
-- every email waited for a person's approval. That approval is now part of Read & write on
-- Gmail itself (the send tool always waits for it), so the extra level is gone and agents that
-- had it keep exactly the behaviour they had.
-- Down: drizzle/down/0107_agent_grants_drop_ask_first_down.sql.

UPDATE "agent_grants" SET "access" = 'read_write' WHERE "access" = 'ask_first';
--> statement-breakpoint
ALTER TABLE "agent_grants" DROP CONSTRAINT IF EXISTS "agent_grants_access_enum";
--> statement-breakpoint
ALTER TABLE "agent_grants"
	ADD CONSTRAINT "agent_grants_access_enum"
	CHECK ("access" IN ('none', 'read', 'read_write'));
