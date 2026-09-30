/**
 * Marketplace v3 catalog types + TanStack Query hooks against the live server.
 *
 * `useMarketplaceCatalog` calls GET /api/marketplace/catalog (Marketplace tech
 * spec §6.1) via the shared api client. The server returns four bands —
 * recommended, popular_loops, top_agents, most_installed_tools — plus a flat
 * team_grid. The v3 page renders five bands (adds Popular skills) and shows
 * numeric counts on each tab, so this file derives `popular_skills` and
 * `tab_counts` from `team_grid` after the response lands. That derivation is
 * the client-side adaptation of the shape mismatch flagged on the task; no
 * server contract change was needed to close it.
 *
 * `useInstallMarketplaceItem` POSTs to /api/marketplace/install (§6.3) and
 * flips the affected card into the installed state optimistically. The mint
 * that produced a `local-` id in the earlier scaffold is gone — the cache
 * writes the real installation `id` returned by the server.
 */

import {
	type MarketplaceCatalogServerCard,
	type MarketplaceCatalogServerResponse,
	api,
} from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
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

export interface InstallFlowCopy {
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
	install_flow_copy?: InstallFlowCopy
	// UI-only affordances not on the wire — brand tile + eyebrow + rich-card
	// description + installed-stats + Asks-you chip + requires pill. Derived
	// from wire fields where a safe default exists; left undefined otherwise
	// and cards render a graceful fallback (see cards.tsx).
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

// ————— Adaptation of the server response —————
//
// The server returns four bands + team_grid; the page needs a fifth band
// (popular_skills) and per-tab counts. Skills come back in team_grid tagged
// item_kind='skill', so we filter+sort them the same way the server sorts
// the other compact bands (install_count desc, top 6). Tab counts count
// rows per kind across the whole team_grid.
//
// Well-known integration slugs get their `brand` token stamped on the card
// so the brand-coloured icon tile in cards.tsx keeps rendering even when
// the seed doesn't ship a `brand` column. Everything else on the card is
// straight from the wire.

const KNOWN_BRAND_SLUGS = new Set<string>([
	'slack',
	'stripe',
	'intercom',
	'linear',
	'salesforce',
	'granola',
])

const VALID_TEAMS: ReadonlySet<MarketplaceTeam> = new Set<MarketplaceTeam>([
	'product',
	'engineering',
	'revenue',
	'marketing',
	'growth',
	'customer',
	'finance_ops',
	'shared',
])

function toItemCard(row: MarketplaceCatalogServerCard): CatalogItemCard {
	const team: MarketplaceTeam = VALID_TEAMS.has(row.team as MarketplaceTeam)
		? (row.team as MarketplaceTeam)
		: 'shared'
	const brand = KNOWN_BRAND_SLUGS.has(row.slug) ? row.slug : undefined
	return {
		item_kind: row.item_kind,
		catalog_id: row.catalog_id,
		slug: row.slug,
		display_name: row.display_name,
		outcome_line: row.outcome_line,
		team,
		requires: row.requires ?? {},
		install_count: row.install_count,
		installed_installation_id: row.installed_installation_id ?? undefined,
		why_line: row.why_line,
		loop_summary: row.loop_summary,
		agent_summary: row.agent_summary,
		install_flow_copy: row.install_flow_copy as InstallFlowCopy | undefined,
		brand,
	}
}

function adaptCatalogResponse(server: MarketplaceCatalogServerResponse): CatalogListResponse {
	const bands = {
		recommended: server.bands.recommended.map(toItemCard),
		popular_loops: server.bands.popular_loops.map(toItemCard),
		top_agents: server.bands.top_agents.map(toItemCard),
		popular_skills: server.team_grid
			.filter((r) => r.item_kind === 'skill')
			.sort((a, b) => b.install_count - a.install_count)
			.slice(0, 6)
			.map(toItemCard),
		most_installed_tools: server.bands.most_installed_tools.map(toItemCard),
	}
	const tab_counts = server.team_grid.reduce(
		(acc, r) => {
			if (r.item_kind === 'loop') acc.loops += 1
			else if (r.item_kind === 'agent') acc.agents += 1
			else if (r.item_kind === 'skill') acc.skills += 1
			else if (r.item_kind === 'mcp_server') acc.tools += 1
			return acc
		},
		{ loops: 0, agents: 0, skills: 0, tools: 0 },
	)
	return {
		bands,
		team_grid: server.team_grid.map(toItemCard),
		tab_counts,
		next_cursor: server.next_cursor ?? undefined,
	}
}

// ————— Hooks —————

export function useMarketplaceCatalog(workspaceId: string, team?: MarketplaceTeam) {
	return useQuery({
		queryKey: queryKeys.marketplaceCatalog.list(workspaceId, team),
		queryFn: async () => {
			const server = await api.marketplaceCatalog.list(workspaceId, { team })
			return adaptCatalogResponse(server)
		},
		staleTime: 30_000,
	})
}

/**
 * Optimistic install — POSTs to /api/marketplace/install and writes the real
 * installation id onto the card in the cache so every band flips immediately.
 * When the query eventually refetches, the server-side
 * `installed_installation_id` takes over.
 */
export function useInstallMarketplaceItem(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (variables: { item_kind: MarketplaceItemKind; catalog_id: string }) =>
			api.marketplaceInstall.install(workspaceId, variables),
		onSuccess: (result, variables) => {
			queryClient.setQueriesData<CatalogListResponse | undefined>(
				{ queryKey: queryKeys.marketplaceCatalog.all(workspaceId) },
				(prev) => {
					if (!prev) return prev
					const flip = (cards: CatalogItemCard[]) =>
						cards.map((c) =>
							c.item_kind === variables.item_kind && c.catalog_id === variables.catalog_id
								? { ...c, installed_installation_id: result.id }
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
			// Follow the marketplace loops hook's pattern for downstream freshness
			// (use-marketplace-loops.ts) — the install materialises workspace-
			// scoped rows in actors / triggers / workspace_skills / integrations
			// per Marketplace tech spec §3.2, and the installed-items list feeds
			// sibling surfaces.
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceItems.installed(workspaceId) })
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
