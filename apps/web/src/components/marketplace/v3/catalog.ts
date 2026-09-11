/**
 * Marketplace v3 catalog types + client-side seed + TanStack Query hooks.
 *
 * These types mirror the CatalogItemCard / GET /api/marketplace/catalog
 * response shape declared in the marketplace technical spec §6.1. Once
 * Marketplace PR #1's schema-derived types land, callers swap the imports
 * over — the runtime shape is identical. Once PR #3's endpoint ships,
 * `catalogListQuery` swaps its `queryFn` body from the seed getter to a
 * real fetch — nothing else on the page changes.
 *
 * The seed strings below are the verbatim design-spec Copy: WHY-line seeds,
 * loop card copy, agent / skill / tool names, install-modal variant strings.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

// ————— Types (mirror tech spec §6.1) —————

export type MarketplaceItemKind = 'loop' | 'agent' | 'skill' | 'mcp_server'

export type MarketplaceTeam =
	| 'product'
	| 'engineering'
	| 'revenue'
	| 'marketing'
	| 'growth'
	| 'customer'
	| 'finance_ops'
	| 'shared'

export interface LoopSummary {
	steps_summary: string
	ins: string[]
	outs: string[]
	cadence: string
}

export interface AgentSummary {
	skills_count: number
	triggers_count: number
}

export interface InstalledStats {
	cycles_this_week: number
	asks_pending: number
}

export interface CatalogItemCard {
	item_kind: MarketplaceItemKind
	catalog_id: string
	slug: string
	display_name: string
	outcome_line: string
	team: MarketplaceTeam
	requires: {
		integrations?: string[]
		mcp_installations?: string[]
	}
	install_count: number
	installed_installation_id?: string
	why_line?: string
	loop_summary?: LoopSummary
	agent_summary?: AgentSummary
	// UI-only affordances not on the wire; used to render brand-coloured icon
	// tiles + eyebrows on rich cards. PR #3 can add these to the response, or
	// the frontend can compute them from slug — either way, the card doesn't
	// need to change.
	brand?: string
	eyebrow?: string
	description?: string
	installed_stats?: InstalledStats
	asks_per_cycle?: number
	requires_status?: 'ready' | 'needs'
	requires_label?: string
}

export interface CatalogListResponse {
	bands: {
		recommended: CatalogItemCard[]
		popular_loops: CatalogItemCard[]
		top_agents: CatalogItemCard[]
		popular_skills: CatalogItemCard[]
		most_installed_tools: CatalogItemCard[]
	}
	team_grid: CatalogItemCard[]
	tab_counts: Record<'loops' | 'agents' | 'skills' | 'tools', number>
	next_cursor?: string
}

// ————— Client-side seed —————
//
// Every string below is design-spec Copy verbatim. Do not edit these on the
// frontend — they land in the seed manifest (packages/shared/src/templates/
// marketplace-catalog.ts) once PR #1 ships, and PR #3's endpoint serves them
// from the DB.

const RECOMMENDED: CatalogItemCard[] = [
	{
		item_kind: 'mcp_server',
		catalog_id: 'seed-granola',
		slug: 'granola',
		display_name: 'Granola',
		outcome_line:
			'MCP server · adds meeting-notes tools to every agent in this workspace',
		team: 'customer',
		requires: { integrations: ['granola'] },
		install_count: 0,
		why_line: 'your Customer Feedback loop reads conversations but not calls',
		brand: 'granola',
		requires_status: 'needs',
		requires_label: 'Needs Granola account',
	},
	{
		item_kind: 'loop',
		catalog_id: 'seed-churn-recovery',
		slug: 'churn-recovery',
		display_name: 'Churn Recovery loop',
		outcome_line: 'Spot quiet accounts before they lapse; hand you the moment worth a call.',
		team: 'customer',
		requires: { integrations: ['posthog'] },
		install_count: 12,
		why_line: 'Sentinel is idle and PostHog is already connected',
		requires_status: 'ready',
		requires_label: 'All integrations ready',
	},
	{
		item_kind: 'mcp_server',
		catalog_id: 'seed-salesforce',
		slug: 'salesforce',
		display_name: 'Salesforce',
		outcome_line: 'Sync accounts, opportunities, and account owners.',
		team: 'revenue',
		requires: { integrations: ['salesforce'] },
		install_count: 4,
		why_line: 'Sentinel needs account ownership to tell a quiet trial from a renewal',
		brand: 'salesforce',
		requires_status: 'ready',
		requires_label: 'Ready',
	},
]

const POPULAR_LOOPS: CatalogItemCard[] = [
	{
		item_kind: 'loop',
		catalog_id: 'seed-customer-feedback',
		slug: 'customer-feedback',
		display_name: 'Customer Feedback loop',
		outcome_line:
			'A loop that closes feedback with every customer — triage, structure, report back — wired end to end.',
		description:
			'A loop that closes feedback with every customer — triage, structure, report back — wired end to end.',
		team: 'customer',
		requires: { integrations: ['intercom'] },
		install_count: 42,
		eyebrow: 'CUSTOMER',
		loop_summary: {
			steps_summary: '',
			ins: ['an Intercom conversation is *tagged feedback*'],
			outs: [
				'Compass drafts a bet when a cluster gets strong enough',
				'Relay writes back to every customer in the cluster',
			],
			cadence: '2× per cycle',
		},
		asks_per_cycle: 2,
		requires_status: 'ready',
		requires_label: 'Intercom ready',
		// Seeded as installed to demonstrate the Manage-row state alongside
		// two not-installed cards in the same band.
		installed_installation_id: 'seed-installation-customer-feedback',
		installed_stats: { cycles_this_week: 3, asks_pending: 0 },
	},
	{
		item_kind: 'loop',
		catalog_id: 'seed-billing-reliability',
		slug: 'billing-reliability',
		display_name: 'Billing Reliability loop',
		outcome_line:
			'Recover failed payments without tickets — detection, retry policy, and a rollback path baked in.',
		description:
			'Recover failed payments without tickets — detection, retry policy, and a rollback path baked in.',
		team: 'revenue',
		requires: { integrations: ['stripe'] },
		install_count: 28,
		eyebrow: 'BILLING',
		loop_summary: {
			steps_summary: '',
			ins: ['a charge fails on a live subscription'],
			outs: [
				'Forge retries the charge behind a flag and records the outcome',
				'Quill sends the next dunning email in the sequence',
			],
			cadence: '2× per cycle',
		},
		asks_per_cycle: 2,
		requires_status: 'needs',
		requires_label: 'Needs Stripe',
	},
	{
		item_kind: 'loop',
		catalog_id: 'seed-churn-recovery-popular',
		slug: 'churn-recovery',
		display_name: 'Churn Recovery loop',
		outcome_line: 'Spot quiet accounts before they lapse; hand you the moment worth a call.',
		description: 'Spot quiet accounts before they lapse; hand you the moment worth a call.',
		team: 'customer',
		requires: { integrations: ['posthog'] },
		install_count: 24,
		eyebrow: 'RETENTION',
		loop_summary: {
			steps_summary: '',
			ins: ['usage drops below the threshold you set'],
			outs: [
				'Sentinel opens a signal with the account timeline',
				'You get a call to open a bet or hold',
			],
			cadence: '1× per cycle',
		},
		asks_per_cycle: 1,
		requires_status: 'ready',
		requires_label: 'PostHog ready',
	},
]

const TOP_AGENTS: CatalogItemCard[] = [
	{
		item_kind: 'agent',
		catalog_id: 'seed-relay',
		slug: 'relay',
		display_name: 'Relay',
		outcome_line: 'Writes back to every customer, always with your sign-off.',
		team: 'customer',
		requires: {},
		install_count: 18,
		brand: 'agent',
	},
	{
		item_kind: 'agent',
		catalog_id: 'seed-compass',
		slug: 'compass',
		display_name: 'Compass',
		outcome_line: 'Structures signals into insights with the evidence linked.',
		team: 'product',
		requires: {},
		install_count: 14,
		installed_installation_id: 'seed-installation-compass',
		brand: 'agent',
	},
	{
		item_kind: 'agent',
		catalog_id: 'seed-sentinel',
		slug: 'sentinel',
		display_name: 'Sentinel',
		outcome_line: 'Flags accounts that are quietly disengaging before they lapse.',
		team: 'customer',
		requires: {},
		install_count: 12,
		brand: 'agent',
	},
	{
		item_kind: 'agent',
		catalog_id: 'seed-forge',
		slug: 'forge',
		display_name: 'Forge',
		outcome_line: 'Recovers failed charges under the retry window you set.',
		team: 'revenue',
		requires: {},
		install_count: 9,
		brand: 'agent',
	},
]

const POPULAR_SKILLS: CatalogItemCard[] = [
	{
		item_kind: 'skill',
		catalog_id: 'seed-plain-english',
		slug: 'plain-english-voice',
		display_name: 'Plain English voice',
		outcome_line: "Rewrites drafts in Maskin's plain-English house style.",
		team: 'shared',
		requires: {},
		install_count: 22,
		brand: 'skill',
	},
	{
		item_kind: 'skill',
		catalog_id: 'seed-foryou-format',
		slug: 'for-you-format',
		display_name: 'For-You format',
		outcome_line: 'Structures a decision as a For-You card.',
		team: 'shared',
		requires: {},
		install_count: 17,
		installed_installation_id: 'seed-installation-foryou-format',
		brand: 'skill',
	},
	{
		item_kind: 'skill',
		catalog_id: 'seed-coding-discipline',
		slug: 'coding-discipline',
		display_name: 'Coding discipline',
		outcome_line: 'Keeps PR diffs small and reviewable.',
		team: 'engineering',
		requires: {},
		install_count: 11,
		brand: 'skill',
	},
	{
		item_kind: 'skill',
		catalog_id: 'seed-maskin-way',
		slug: 'maskin-way-of-working',
		display_name: 'Maskin way of working',
		outcome_line: 'Grounds an agent in bet/loop/task vocabulary.',
		team: 'shared',
		requires: {},
		install_count: 9,
		brand: 'skill',
	},
]

const MOST_INSTALLED_TOOLS: CatalogItemCard[] = [
	{
		item_kind: 'mcp_server',
		catalog_id: 'seed-slack',
		slug: 'slack',
		display_name: 'Slack',
		outcome_line: 'Send messages, join channels, read threads.',
		team: 'shared',
		requires: {},
		install_count: 46,
		installed_installation_id: 'seed-installation-slack',
		brand: 'slack',
	},
	{
		item_kind: 'mcp_server',
		catalog_id: 'seed-intercom',
		slug: 'intercom',
		display_name: 'Intercom',
		outcome_line: 'Read conversations, tag, reply on behalf of an agent.',
		team: 'customer',
		requires: {},
		install_count: 33,
		installed_installation_id: 'seed-installation-intercom',
		brand: 'intercom',
	},
	{
		item_kind: 'mcp_server',
		catalog_id: 'seed-linear',
		slug: 'linear',
		display_name: 'Linear',
		outcome_line: 'Read issues, create tickets, comment.',
		team: 'engineering',
		requires: { integrations: ['linear'] },
		install_count: 27,
		brand: 'linear',
	},
	{
		item_kind: 'mcp_server',
		catalog_id: 'seed-stripe',
		slug: 'stripe',
		display_name: 'Stripe',
		outcome_line: 'Read charges, subscriptions, and payment failures.',
		team: 'revenue',
		requires: { integrations: ['stripe'] },
		install_count: 24,
		brand: 'stripe',
	},
]

const CATALOG_SEED: CatalogListResponse = {
	bands: {
		recommended: RECOMMENDED,
		popular_loops: POPULAR_LOOPS,
		top_agents: TOP_AGENTS,
		popular_skills: POPULAR_SKILLS,
		most_installed_tools: MOST_INSTALLED_TOOLS,
	},
	team_grid: [
		...POPULAR_LOOPS,
		...TOP_AGENTS,
		...POPULAR_SKILLS,
		...MOST_INSTALLED_TOOLS,
	],
	tab_counts: { loops: 24, agents: 18, skills: 32, tools: 46 },
}

// ————— Query keys —————

export const marketplaceCatalogKeys = {
	all: ['marketplace-v3', 'catalog'] as const,
	list: (team?: MarketplaceTeam) =>
		['marketplace-v3', 'catalog', { team: team ?? null }] as const,
}

/**
 * Swap the body of this function for a real `fetch('/api/marketplace/catalog?…')`
 * call once Marketplace PR #3 lands the endpoint. Callers stay unchanged.
 */
async function fetchMarketplaceCatalog(
	_workspaceId: string,
	team?: MarketplaceTeam,
): Promise<CatalogListResponse> {
	// Simulate a small network delay so band-level skeletons paint at least
	// one frame during dev — otherwise the loading state is impossible to
	// visually verify without React DevTools.
	await new Promise((r) => setTimeout(r, 250))
	if (!team) return CATALOG_SEED
	const inTeam = (item: CatalogItemCard) => item.team === team || item.team === 'shared'
	return {
		...CATALOG_SEED,
		bands: {
			recommended: CATALOG_SEED.bands.recommended.filter(inTeam),
			popular_loops: CATALOG_SEED.bands.popular_loops.filter(inTeam),
			top_agents: CATALOG_SEED.bands.top_agents.filter(inTeam),
			popular_skills: CATALOG_SEED.bands.popular_skills.filter(inTeam),
			most_installed_tools: CATALOG_SEED.bands.most_installed_tools.filter(inTeam),
		},
		team_grid: CATALOG_SEED.team_grid.filter(inTeam),
	}
}

export function useMarketplaceCatalog(workspaceId: string, team?: MarketplaceTeam) {
	return useQuery({
		queryKey: marketplaceCatalogKeys.list(team),
		queryFn: () => fetchMarketplaceCatalog(workspaceId, team),
		staleTime: 30_000,
	})
}

/**
 * Optimistic install — writes the `installed_installation_id` field onto the
 * card in the cache so all bands flip to installed state immediately. Real
 * POST /api/marketplace/install lands in PR #2; that PR wires its emit
 * against the same key so the query invalidates.
 */
export function useInstallMarketplaceItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async ({
			item_kind,
			catalog_id,
		}: {
			item_kind: MarketplaceItemKind
			catalog_id: string
		}) => {
			await new Promise((r) => setTimeout(r, 900))
			return {
				installation_id: `local-${item_kind}-${catalog_id}-${Date.now()}`,
			}
		},
		onSuccess: (result, variables) => {
			queryClient.setQueriesData<CatalogListResponse | undefined>(
				{ queryKey: marketplaceCatalogKeys.all },
				(prev) => {
					if (!prev) return prev
					const flip = (cards: CatalogItemCard[]) =>
						cards.map((c) =>
							c.item_kind === variables.item_kind && c.catalog_id === variables.catalog_id
								? { ...c, installed_installation_id: result.installation_id }
								: c,
						)
					const dropInstalledRecommended = flip(prev.bands.recommended).filter(
						(c) => !c.installed_installation_id,
					)
					return {
						...prev,
						bands: {
							recommended: dropInstalledRecommended,
							popular_loops: flip(prev.bands.popular_loops),
							top_agents: flip(prev.bands.top_agents),
							popular_skills: flip(prev.bands.popular_skills),
							most_installed_tools: flip(prev.bands.most_installed_tools),
						},
						team_grid: flip(prev.team_grid),
					}
				},
			)
			void workspaceId
		},
	})
}

export const TEAM_LABELS: Array<{ value: MarketplaceTeam | 'all'; label: string }> = [
	{ value: 'all', label: 'All teams' },
	{ value: 'product', label: 'Product' },
	{ value: 'engineering', label: 'Engineering' },
	{ value: 'revenue', label: 'Revenue' },
	{ value: 'marketing', label: 'Marketing' },
	{ value: 'growth', label: 'Growth' },
	{ value: 'customer', label: 'Customer' },
	{ value: 'finance_ops', label: 'Finance & Ops' },
	{ value: 'shared', label: 'Shared' },
]

export function teamLabel(team: MarketplaceTeam | 'all'): string {
	return TEAM_LABELS.find((t) => t.value === team)?.label ?? String(team)
}
