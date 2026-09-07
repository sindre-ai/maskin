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
		outcomeLine: 'Keeps tasks and bets moving — re-kicks failed sessions and fills missing drivers.',
		description:
			'Operational sweep agent. Daily pass over the `todo` column that unblocks stuck work, diagnoses session failures from logs, and re-kicks or reassigns drivers with a bias toward action over observation.',
		skillSlugs: ['maskin-way-of-working'],
		team: 'shared',
		sortWeight: 100,
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
	},
	{
		slug: 'signal-analyst',
		displayName: 'Signal Analyst',
		outcomeLine: 'Clusters raw insight signal into candidate bets and stages them for shaping.',
		description:
			'Triages new insights immediately, runs a daily clustering sweep, and re-validates the `signal`-bet inventory weekly.',
		team: 'product',
		sortWeight: 80,
	},
	{
		slug: 'researcher',
		displayName: 'Researcher',
		outcomeLine: 'Supplies source-backed briefs and files insights for the discovery loop.',
		description:
			'Files insight objects from external sources and internal signals with citation trails Signal Analyst can cluster.',
		team: 'shared',
		sortWeight: 70,
	},
	{
		slug: 'knowledge-curator',
		displayName: 'Knowledge Curator',
		outcomeLine: 'Maintains the human-facing knowledge wiki and publishes the twice-weekly digest.',
		description:
			'Folds new knowledge objects into the graph, wires supersedes/contradicts lineage, and compiles the human-readable digest on cadence.',
		team: 'shared',
		sortWeight: 50,
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
	},
	{
		slug: 'shaped-bet-format',
		displayName: 'Shaped bet format',
		outcomeLine: 'The Shape Up format for bets ready to hand to Planner.',
		description:
			'Pitch summary, appetite, success criteria (won / lost / inconclusive), solution sketch, rabbit-hole notes, and no-goes.',
		team: 'product',
		sortWeight: 80,
	},
	{
		slug: 'maskin-way-of-working',
		displayName: 'Maskin way of working',
		outcomeLine: 'Workspace-wide conventions every agent should follow.',
		description:
			'Rendering rules, mention conventions, attention-score guidance, and the house style for agents operating in Maskin workspaces.',
		team: 'shared',
		sortWeight: 75,
	},
	{
		slug: 'continuous-onboarding',
		displayName: 'Continuous onboarding',
		outcomeLine: 'The onboarding format Chief of Staff runs for new workspace humans.',
		description:
			'Sequenced prompts and escalations that keep onboarding moving without dumping everything on day one.',
		team: 'customer',
		sortWeight: 60,
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
