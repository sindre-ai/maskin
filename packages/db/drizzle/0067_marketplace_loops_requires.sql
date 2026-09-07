-- Extend marketplace_loops with the install-time dependency manifest read
-- by apps/dev/src/services/marketplace-install.ts to return 424 when a
-- workspace is missing required integrations or MCP installations.
-- Shape: { integrations?: string[], mcp_installations?: string[] }.
ALTER TABLE "marketplace_loops"
	ADD COLUMN IF NOT EXISTS "requires" jsonb NOT NULL DEFAULT '{}'::jsonb;
