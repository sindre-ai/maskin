-- Agent grants: a fourth level, ask_first.
--
-- "Ask first" is between read and read_write: the agent may use the integration's tools, but an
-- action that cannot be undone (today: sending an email through Gmail) waits for a person to
-- approve it on a For You approval card. read_write stays "all tools, no questions asked".
--
-- Existing Gmail read_write grants become ask_first. Until now "write" on Gmail meant creating
-- drafts, because Google's Gmail tool cannot send; the new send tool would otherwise let every
-- one of those agents start sending the day this ships. Nobody loses anything they could do,
-- and a person who wants an agent to send on its own switches it to Read & write.
-- Down: drizzle/down/0100_agent_grants_ask_first_down.sql.

ALTER TABLE "agent_grants" DROP CONSTRAINT IF EXISTS "agent_grants_access_enum";
--> statement-breakpoint
ALTER TABLE "agent_grants"
	ADD CONSTRAINT "agent_grants_access_enum"
	CHECK ("access" IN ('none', 'read', 'ask_first', 'read_write'));
--> statement-breakpoint
UPDATE "agent_grants" AS g
	SET "access" = 'ask_first'
	FROM "integrations" AS i
	WHERE g."integration_id" = i."id"
		AND i."provider" = 'gmail'
		AND g."access" = 'read_write';
