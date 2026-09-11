-- Adds `install_flow_copy` JSONB to every catalog table so the install modal
-- can render its per-item strings from the endpoint instead of hardcoded
-- literals. See Marketplace design spec §Copy → "Install modal — per-item
-- copy is catalog metadata" and Marketplace v1.1 polish task.
--
-- Shape (all fields optional; omitted for paths an item never enters):
--   {
--     needs_integration:  { subtitle?, step_1_body? },
--     needs_decision:     { subtitle?, warning_callout? },
--     installing:         { step_2_body?, step_3_body? },
--     success:            { subtitle?, callout? },
--     error:              { callout? }
--   }
--
-- Strings may embed the placeholder tokens {integration}, {team}, {agents},
-- {trigger_count} — the frontend resolves them at render time.
--
-- Defaults to '{}' so pre-existing rows load cleanly; the seed reify below
-- populates it for every currently-seeded item. The marketplace_mcp_servers
-- view is dropped and recreated so its projection carries the new column;
-- because it is still an empty stub (see 0072), no data is lost.
ALTER TABLE "marketplace_loops"
	ADD COLUMN IF NOT EXISTS "install_flow_copy" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "marketplace_agents"
	ADD COLUMN IF NOT EXISTS "install_flow_copy" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "marketplace_skills"
	ADD COLUMN IF NOT EXISTS "install_flow_copy" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- Rebuild the mcp_servers view with the new column so the catalog UNION-ALL
-- can select `install_flow_copy` uniformly across all four item_kinds. Body
-- otherwise unchanged from 0072 — this file replaces its projection, not its
-- semantics.
DROP VIEW IF EXISTS "marketplace_mcp_servers";
--> statement-breakpoint
CREATE VIEW "marketplace_mcp_servers" AS
SELECT
	NULL::uuid           AS id,
	NULL::uuid           AS workspace_id,
	NULL::text           AS slug,
	NULL::text           AS display_name,
	NULL::text           AS description,
	NULL::text           AS outcome_line,
	'shared'::text       AS team,
	'{}'::jsonb          AS recommendation,
	'{}'::jsonb          AS requires,
	'published'::text    AS status,
	0::integer           AS sort_weight,
	0::integer           AS install_count,
	'{}'::jsonb          AS install_flow_copy,
	NULL::timestamptz    AS created_at,
	NULL::timestamptz    AS updated_at
WHERE false;
--> statement-breakpoint

-- ── Backfill install_flow_copy for the seeded catalog (0073) ─────────────
-- Each item gets the copy its actual install flow needs. Loops go through
-- needs-decision → installing → success (+ error on failure). Agents and
-- skills currently skip needs-integration (no `requires`) and go straight
-- through needs-decision. The placeholders {agents}, {trigger_count} resolve
-- at render time from the item's own metadata. Fields for paths an item
-- never enters are omitted.
UPDATE "marketplace_loops" SET install_flow_copy = $$
{
	"needs_decision": {
		"subtitle": "Choose which team owns this loop so its asks land in the right feed.",
		"warning_callout": "Installing wires up the loop's agents, triggers, and integration reads. Nothing writes to a customer without your sign-off."
	},
	"installing": {
		"step_2_body": "Wiring the loop's agents into your workspace.",
		"step_3_body": "Registering triggers so the loop fires on its cadence."
	},
	"success": {
		"subtitle": "Cycle 1 opens the next time a trigger fires.",
		"callout": "The loop is in your workspace. You'll get a For-You card when a cycle asks for you."
	},
	"error": {
		"callout": "Something failed while wiring the loop. Nothing was changed in your workspace. Try again, or ping #maskin-help if it keeps happening."
	}
}
$$::jsonb WHERE slug IN ('discovery-bet', 'workspace-improvements', 'knowledge-wiki-digest') AND workspace_id IS NULL;
--> statement-breakpoint

UPDATE "marketplace_agents" SET install_flow_copy = $$
{
	"needs_decision": {
		"subtitle": "Choose which team owns this agent so its work lands in the right feed.",
		"warning_callout": "Installing wires the agent into your workspace with the skills it needs. Nothing writes on your behalf without your sign-off."
	},
	"installing": {
		"step_2_body": "Adding the agent and its skills to your workspace.",
		"step_3_body": "Registering the agent's triggers so it fires on cadence."
	},
	"success": {
		"subtitle": "The agent is available in your workspace.",
		"callout": "You can pair the agent with a loop, or hand it work directly from any bet or task."
	},
	"error": {
		"callout": "Something failed while installing the agent. Nothing was changed in your workspace. Try again, or ping #maskin-help if it keeps happening."
	}
}
$$::jsonb WHERE slug IN ('driver', 'strategist', 'signal-analyst', 'researcher', 'knowledge-curator') AND workspace_id IS NULL;
--> statement-breakpoint

UPDATE "marketplace_skills" SET install_flow_copy = $$
{
	"needs_decision": {
		"subtitle": "Choose which team this skill belongs to so it appears in the right agent library.",
		"warning_callout": "Installing makes the skill available for any agent in this workspace to attach."
	},
	"installing": {
		"step_2_body": "Adding the skill to your workspace's shared library.",
		"step_3_body": "Available for any agent to attach."
	},
	"success": {
		"subtitle": "The skill is in your workspace library.",
		"callout": "Attach it to any agent from that agent's page."
	},
	"error": {
		"callout": "Something failed while installing the skill. Nothing was changed in your workspace. Try again, or ping #maskin-help if it keeps happening."
	}
}
$$::jsonb WHERE slug IN ('for-you-format', 'shaped-bet-format', 'maskin-way-of-working', 'continuous-onboarding') AND workspace_id IS NULL;
