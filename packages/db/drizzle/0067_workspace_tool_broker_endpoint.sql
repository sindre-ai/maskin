-- Record which broker instance a workspace's toolkit lives on.
--
-- Every row points at the same URL today: one instance, one tenant. The column
-- exists now so that stops being true without a schema change.
--
-- WHY THAT MATTERS. The backend pins every session to a single boot-seeded
-- organization (a database hook overwrites activeOrganizationId on session
-- create) and refuses to create a second one, so per-workspace tenancy is not
-- reachable on one instance. If a hosted deployment ever needs vendor-enforced
-- isolation, the answer is an instance per workspace — which becomes an
-- orchestration change rather than a migration, because the mapping already
-- knows where each workspace's toolkit lives.
--
-- NULL means "the instance named by TOOL_BROKER_URL", so existing rows keep
-- working and a single-instance deployment never has to populate it.

ALTER TABLE "workspace_tool_brokers"
	ADD COLUMN IF NOT EXISTS "endpoint_url" text;

COMMENT ON COLUMN "workspace_tool_brokers"."endpoint_url" IS
	'Broker instance hosting this workspace toolkit. NULL means the default from TOOL_BROKER_URL.';
