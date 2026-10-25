-- Default agent access: a third level, read_write.
--
-- integrations.default_agent_access is what an agent with no agent_grants row gets. It could
-- only be 'read' or 'none', so letting every agent write meant adding a grant per agent. A
-- person can now pick "Read & write" for "All other agents" on the Integrations page.
-- No existing row changes: this only widens what the column accepts.
-- Down: drizzle/down/0106_default_agent_access_read_write_down.sql.

ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_default_agent_access_enum";
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_default_agent_access_enum"
	CHECK ("default_agent_access" IN ('read', 'read_write', 'none'));
