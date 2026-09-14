/**
 * Marketplace catalog seed manifest.
 *
 * V1 admin curation surface per Marketplace tech spec §7: hand-authored TS
 * records describing every global catalog entry (loops, agents, skills)
 * that ships with Maskin. The initial reify lives in
 * `packages/db/drizzle/0073_seed_marketplace_catalog.sql`; the arrays here
 * document what that migration inserts and pin the superset guarantee for
 * `marketplace-seed-overlap.test.ts` (every seed $id appears here).
 *
 * Curation loop:
 *   1. Author changes here (add / update / mark deprecated a catalog entry).
 *   2. Ship a NEW migration file in packages/db/drizzle/ that mirrors the
 *      change as an INSERT ... ON CONFLICT DO UPDATE (or an UPDATE to flip
 *      status → 'deprecated'). Do NOT edit 0073 in place — migrations are
 *      append-only.
 *   3. Un-block any downstream tests pinned to the manifest shape.
 *
 * The catalog is a SUPERSET of DEFAULT_WORKSPACE_LOOPS / AGENTS in
 * default-workspace-agents.ts: every seeded item is discoverable from the
 * Marketplace, plus room for hand-curated additions in later migrations.
 * Slugs are kebab-cased versions of the seed $ids so overlap tests can
 * join the two.
 */

export type MarketplaceTeam =
	| 'product'
	| 'engineering'
	| 'revenue'
	| 'marketing'
	| 'growth'
	| 'customer'
	| 'finance_ops'
	| 'shared'

export interface MarketplaceRequiresManifest {
	integrations?: string[]
	mcp_installations?: string[]
}

/**
 * Per-item copy the install modal renders across its five variants. Fields
 * for paths an item never enters are optional / omitted. Strings may embed
 * the placeholder tokens `{integration}`, `{team}`, `{agents}`,
 * `{trigger_count}` — the frontend resolves them at render time.
 *
 * See Marketplace design spec §Copy → "Install modal — per-item copy is
 * catalog metadata".
 */
export interface MarketplaceInstallFlowCopy {
	needs_integration?: {
		subtitle?: string
		step_1_body?: string
	}
	needs_decision?: {
		subtitle?: string
		warning_callout?: string
	}
	installing?: {
		step_2_body?: string
		step_3_body?: string
	}
	success?: {
		subtitle?: string
		callout?: string
	}
	error?: {
		callout?: string
	}
}

export interface MarketplaceCatalogLoopEntry {
	slug: string
	name: string
	description: string
	version: string
	useCase: string
	team: MarketplaceTeam
	requires?: MarketplaceRequiresManifest
	recommendation?: Record<string, unknown>
	sortWeight?: number
	installFlowCopy?: MarketplaceInstallFlowCopy
}

export interface MarketplaceCatalogAgentEntry {
	slug: string
	displayName: string
	outcomeLine: string
	description: string
	/** Skill slugs pre-attached at install (must exist in marketplace_skills). */
	skillSlugs?: string[]
	team: MarketplaceTeam
	requires?: MarketplaceRequiresManifest
	recommendation?: Record<string, unknown>
	sortWeight?: number
	installFlowCopy?: MarketplaceInstallFlowCopy
}

export interface MarketplaceCatalogSkillEntry {
	slug: string
	displayName: string
	outcomeLine: string
	description: string
	team: MarketplaceTeam
	requires?: MarketplaceRequiresManifest
	recommendation?: Record<string, unknown>
	sortWeight?: number
	installFlowCopy?: MarketplaceInstallFlowCopy
}

/**
 * Default install-flow copy for a loop. Loops go through needs-decision →
 * installing → success (with error on failure). Custom items override any
 * field they want to differ; anything unset falls back to these strings.
 * Placeholders `{integration}`, `{team}`, `{agents}`, `{trigger_count}` are
 * resolved at render time from the item's own metadata.
 */
export const DEFAULT_LOOP_INSTALL_FLOW_COPY: MarketplaceInstallFlowCopy = {
	needs_decision: {
		subtitle: 'Choose which team owns this loop so its asks land in the right feed.',
		warning_callout:
			"Installing wires up the loop's agents, triggers, and integration reads. Nothing writes to a customer without your sign-off.",
	},
	installing: {
		step_2_body: "Wiring the loop's agents into your workspace.",
		step_3_body: 'Registering triggers so the loop fires on its cadence.',
	},
	success: {
		subtitle: 'Cycle 1 opens the next time a trigger fires.',
		callout: "The loop is in your workspace. You'll get a For-You card when a cycle asks for you.",
	},
	error: {
		callout:
			'Something failed while wiring the loop. Nothing was changed in your workspace. Try again, or ping #maskin-help if it keeps happening.',
	},
}

export const DEFAULT_AGENT_INSTALL_FLOW_COPY: MarketplaceInstallFlowCopy = {
	needs_decision: {
		subtitle: 'Choose which team owns this agent so its work lands in the right feed.',
		warning_callout:
			'Installing wires the agent into your workspace with the skills it needs. Nothing writes on your behalf without your sign-off.',
	},
	installing: {
		step_2_body: 'Adding the agent and its skills to your workspace.',
		step_3_body: "Registering the agent's triggers so it fires on cadence.",
	},
	success: {
		subtitle: 'The agent is available in your workspace.',
		callout: 'You can pair the agent with a loop, or hand it work directly from any bet or task.',
	},
	error: {
		callout:
			'Something failed while installing the agent. Nothing was changed in your workspace. Try again, or ping #maskin-help if it keeps happening.',
	},
}

export const DEFAULT_SKILL_INSTALL_FLOW_COPY: MarketplaceInstallFlowCopy = {
	needs_decision: {
		subtitle: 'Choose which team this skill belongs to so it appears in the right agent library.',
		warning_callout:
			'Installing makes the skill available for any agent in this workspace to attach.',
	},
	installing: {
		step_2_body: "Adding the skill to your workspace's shared library.",
		step_3_body: 'Available for any agent to attach.',
	},
	success: {
		subtitle: 'The skill is in your workspace library.',
		callout: "Attach it to any agent from that agent's page.",
	},
	error: {
		callout:
			'Something failed while installing the skill. Nothing was changed in your workspace. Try again, or ping #maskin-help if it keeps happening.',
	},
}

/**
 * Loops in the initial marketplace catalog. Slugs match the kebab-cased
 * DEFAULT_WORKSPACE_LOOPS $ids in default-workspace-agents.ts so the
 * seed-overlap test can pin superset membership.
 */
export const MARKETPLACE_CATALOG_LOOPS: MarketplaceCatalogLoopEntry[] = [
	{
		slug: 'discovery-bet',
		name: 'Bet discovery loop',
		description:
			'Turns raw insights into shaped Shape Up bets. Signal Analyst triages new insights immediately and runs a daily/weekly clustering sweep; a human promotes to `define`; Strategist shapes the pitch.',
		version: '1.0.0',
		useCase: 'Insight triage and bet shaping',
		team: 'product',
		sortWeight: 100,
		installFlowCopy: DEFAULT_LOOP_INSTALL_FLOW_COPY,
	},
	{
		slug: 'workspace-improvements',
		name: 'Workspace improvements',
		description:
			'Turns Workspace Coach coaching signals into clustered, actionable recommendations for the human.',
		version: '1.0.0',
		useCase: 'Workspace observability and coaching',
		team: 'shared',
		sortWeight: 60,
		installFlowCopy: DEFAULT_LOOP_INSTALL_FLOW_COPY,
	},
	{
		slug: 'knowledge-wiki-digest',
		name: 'Knowledge Wiki digest',
		description:
			'Maintains the human-facing knowledge wiki and publishes a twice-weekly digest of what changed.',
		version: '1.0.0',
		useCase: 'Knowledge management',
		team: 'shared',
		sortWeight: 40,
		installFlowCopy: DEFAULT_LOOP_INSTALL_FLOW_COPY,
	},
]

/**
 * Agents in the initial marketplace catalog. Slugs are the DEFAULT_WORKSPACE_
 * AGENTS $ids (already kebab-cased or underscore-cased — kebab wins for URL
 * safety). System prompts here are short markers; the workspace-bootstrap
 * path materializes the full prompt from default-workspace-agents.ts.
 */
export const MARKETPLACE_CATALOG_AGENTS: MarketplaceCatalogAgentEntry[] = [
	{
		slug: 'driver',
		displayName: 'Driver',
		outcomeLine:
			'Keeps tasks and bets moving — re-kicks failed sessions and fills missing drivers.',
		description:
			'Operational sweep agent. Daily pass over the `todo` column that unblocks stuck work, diagnoses session failures from logs, and re-kicks or reassigns drivers with a bias toward action over observation.',
		skillSlugs: ['maskin-way-of-working'],
		team: 'shared',
		sortWeight: 100,
		installFlowCopy: DEFAULT_AGENT_INSTALL_FLOW_COPY,
	},
	{
		slug: 'strategist',
		displayName: 'Strategist',
		outcomeLine: 'Shapes define-stage bets into falsifiable Shape Up specs.',
		description:
			'Sole owner of the shaping phase. Takes bets in `define`, drafts a Shape Up pitch, and routes load-bearing unknowns before promoting to `active`.',
		skillSlugs: ['shaped-bet-format', 'maskin-way-of-working'],
		team: 'product',
		sortWeight: 95,
		installFlowCopy: DEFAULT_AGENT_INSTALL_FLOW_COPY,
	},
	{
		slug: 'signal-analyst',
		displayName: 'Signal Analyst',
		outcomeLine: 'Clusters raw insight signal into candidate bets and stages them for shaping.',
		description:
			'Triages new insights immediately, runs a daily clustering sweep, and re-validates the `signal`-bet inventory weekly.',
		team: 'product',
		sortWeight: 80,
		installFlowCopy: DEFAULT_AGENT_INSTALL_FLOW_COPY,
	},
	{
		slug: 'researcher',
		displayName: 'Researcher',
		outcomeLine: 'Supplies source-backed briefs and files insights for the discovery loop.',
		description:
			'Files insight objects from external sources and internal signals with citation trails Signal Analyst can cluster.',
		team: 'shared',
		sortWeight: 70,
		installFlowCopy: DEFAULT_AGENT_INSTALL_FLOW_COPY,
	},
	{
		slug: 'knowledge-curator',
		displayName: 'Knowledge Curator',
		outcomeLine: 'Maintains the human-facing knowledge wiki and publishes the twice-weekly digest.',
		description:
			'Folds new knowledge objects into the graph, wires supersedes/contradicts lineage, and compiles the human-readable digest on cadence.',
		team: 'shared',
		sortWeight: 50,
		installFlowCopy: DEFAULT_AGENT_INSTALL_FLOW_COPY,
	},
]

/**
 * Skills in the initial marketplace catalog. Slugs match the SeedSkill.name
 * values in default-workspace-agents.ts so the seed-overlap test can pin
 * superset membership.
 */
export const MARKETPLACE_CATALOG_SKILLS: MarketplaceCatalogSkillEntry[] = [
	{
		slug: 'for-you-format',
		displayName: 'For You format',
		outcomeLine: 'Mandatory format for anything landing in the human For You queue.',
		description:
			'One decision per item; never write when nothing is blocked. Attach to any agent that routinely escalates.',
		team: 'shared',
		sortWeight: 90,
		installFlowCopy: DEFAULT_SKILL_INSTALL_FLOW_COPY,
	},
	{
		slug: 'shaped-bet-format',
		displayName: 'Shaped bet format',
		outcomeLine: 'The Shape Up format for bets ready to hand to Planner.',
		description:
			'Pitch summary, appetite, success criteria (won / lost / inconclusive), solution sketch, rabbit-hole notes, and no-goes.',
		team: 'product',
		sortWeight: 80,
		installFlowCopy: DEFAULT_SKILL_INSTALL_FLOW_COPY,
	},
	{
		slug: 'maskin-way-of-working',
		displayName: 'Maskin way of working',
		outcomeLine: 'Workspace-wide conventions every agent should follow.',
		description:
			'Rendering rules, mention conventions, attention-score guidance, and the house style for agents operating in Maskin workspaces.',
		team: 'shared',
		sortWeight: 75,
		installFlowCopy: DEFAULT_SKILL_INSTALL_FLOW_COPY,
	},
	{
		slug: 'continuous-onboarding',
		displayName: 'Continuous onboarding',
		outcomeLine: 'The onboarding format Chief of Staff runs for new workspace humans.',
		description:
			'Sequenced prompts and escalations that keep onboarding moving without dumping everything on day one.',
		team: 'customer',
		sortWeight: 60,
		installFlowCopy: DEFAULT_SKILL_INSTALL_FLOW_COPY,
	},
]

/**
 * Convenience helper: every slug the initial reify seeds, flattened per
 * kind. Used by marketplace-seed-overlap.test.ts to assert superset
 * membership against DEFAULT_WORKSPACE_LOOPS/AGENTS/SKILLS.
 */
export const MARKETPLACE_CATALOG_SLUGS = {
	loops: MARKETPLACE_CATALOG_LOOPS.map((l) => l.slug),
	agents: MARKETPLACE_CATALOG_AGENTS.map((a) => a.slug),
	skills: MARKETPLACE_CATALOG_SKILLS.map((s) => s.slug),
} as const
