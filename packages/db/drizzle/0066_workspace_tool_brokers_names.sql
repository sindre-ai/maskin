-- Cache the workspace's connected integration names on its provisioning row.
--
-- WHY DENORMALISE. Session launch injects a short preamble telling the agent
-- which integrations it can reach — without it agents do not discover the tools
-- at all, because the broker deliberately presents a small fixed tool surface
-- that advertises nothing about what sits behind it.
--
-- Reading those names live would put a network call on the session-launch hot
-- path, where a slow or unreachable backend would delay or fail a launch that
-- has nothing else to do with integrations. A cached column keeps launch free of
-- broker I/O entirely, which is the property that matters: an integrations
-- outage must never stop an agent from starting.
--
-- Drift is bounded because the connect and disconnect routes are the only
-- writers, and a stale name costs a slightly wrong sentence in a prompt, not a
-- wrong capability — the tools themselves are authorised by toolkit membership,
-- not by this column.

ALTER TABLE "workspace_tool_brokers"
	ADD COLUMN IF NOT EXISTS "connected_names" jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN "workspace_tool_brokers"."connected_names" IS
	'Display names of connected integrations, cached for the session-launch preamble. Authoritative source is the broker; this is a hint, never an authorisation input.';
