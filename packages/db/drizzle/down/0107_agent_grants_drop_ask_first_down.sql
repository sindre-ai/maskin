-- Rollback for 0107. Brings back the ask_first level. Existing Gmail read_write grants become
-- ask_first again, as in 0100, so rolling the code back does not let those agents start sending
-- on their own (the old code sent directly at read_write).
--
-- Lives under drizzle/down/ so the forward runner never sees it.

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
