-- Rollback for 0106_default_agent_access_read_write.sql. A default of read_write cannot be kept
-- under the old constraint, so those integrations fall back to 'read' (they lose the write
-- half of the default; per-agent grants are untouched).
UPDATE "integrations" SET "default_agent_access" = 'read' WHERE "default_agent_access" = 'read_write';
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_default_agent_access_enum";
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_default_agent_access_enum"
	CHECK ("default_agent_access" IN ('read', 'none'));
