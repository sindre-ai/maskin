-- Rollback for 0100. ask_first becomes read_write, which is what those Gmail agents had before
-- the send tool existed (drafts only, since nothing could send). Restores the old level set.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE "agent_grants" SET "access" = 'read_write' WHERE "access" = 'ask_first';
--> statement-breakpoint
ALTER TABLE "agent_grants" DROP CONSTRAINT IF EXISTS "agent_grants_access_enum";
--> statement-breakpoint
ALTER TABLE "agent_grants"
	ADD CONSTRAINT "agent_grants_access_enum" CHECK ("access" IN ('none', 'read', 'read_write'));
