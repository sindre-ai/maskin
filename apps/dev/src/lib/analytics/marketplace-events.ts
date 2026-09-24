import { capturePosthogEvent } from './posthog'

// Server-side emitters for the Marketplace bet — closes Product Validator's
// two v1 blockers: (1) loop_installed.source was missing the semantic source
// tag, and (2) agent/skill/tool_installed events didn't exist, so three of
// the four Marketplace tabs would launch blind.
//
// Wire names in MARKETPLACE_EVENTS are the source of truth — both server
// (this module) and client (PR #4's frontend, via the browser posthog
// client) reference these constants so the string never drifts between
// the emit site and the PostHog dashboard filter.
//
// The bet's install-pull hypothesis is measured by filtering PostHog on
// { event: 'loop_installed' | 'agent_installed' | 'skill_installed' | 'tool_installed',
//   source: 'marketplace' } — every card-triggered install lands under
// exactly one of those four events with source='marketplace', so all four
// tabs are measurable at launch under the same filter shape.

export type MarketplaceItemKind = 'loop' | 'agent' | 'skill' | 'mcp_server'

// The semantic source of the install — how the install was triggered, not
// which UI page it originated on. Product Validator's Marketplace tab-level
// success criteria all filter on `source = 'marketplace'` — that's every
// user-triggered install through a Marketplace card, regardless of whether
// the click happened on a band card or an item detail page.
//
//   marketplace  → user clicked Install on a Marketplace card or detail page
//   seed         → workspace-bootstrap provisioned it at workspace creation
//   api          → written through the public API (not via UI)
export type MarketplaceInstallSource = 'marketplace' | 'seed' | 'api'

// Bands referenced by the page-viewed + item-viewed events. Kept aligned with
// tech spec §6.1's CatalogListResponse.bands shape.
export type MarketplaceBand =
	| 'recommended'
	| 'popular_loops'
	| 'top_agents'
	| 'popular_skills'
	| 'most_installed_tools'
	| 'team_grid'

export const MARKETPLACE_EVENTS = {
	pageViewed: 'marketplace_page_viewed',
	itemViewed: 'marketplace_item_viewed',
	itemInstalled: 'marketplace_item_installed',
	itemUninstalled: 'marketplace_item_uninstalled',
	installRequiresFailed: 'marketplace_install_requires_failed',
	// Per-kind derivative events fired alongside marketplace_item_installed
	// so each tab's success metric can filter on a single event name plus
	// source='marketplace'. loop_installed already exists in loop-events.ts
	// and is re-shaped there (never emitted from this module).
	agentInstalled: 'agent_installed',
	skillInstalled: 'skill_installed',
	toolInstalled: 'tool_installed',
} as const

interface PageViewedProps {
	workspaceId: string
	actorId: string
	band: MarketplaceBand
}

export async function trackMarketplacePageViewed(p: PageViewedProps): Promise<void> {
	await capturePosthogEvent(MARKETPLACE_EVENTS.pageViewed, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		band: p.band,
	})
}

// marketplace_item_viewed is fired frontend-side, throttled per intersection
// observer — the client uses the browser posthog SDK. This server-side
// emitter exists for parity (integration tests + the seed-reify path can
// synthesise a view event if needed) and to lock the wire shape.
export interface MarketplaceItemViewedProps {
	workspaceId: string
	itemKind: MarketplaceItemKind
	catalogSlug: string
	sourceBand: MarketplaceBand
	position: number
}

export async function trackMarketplaceItemViewed(p: MarketplaceItemViewedProps): Promise<void> {
	await capturePosthogEvent(MARKETPLACE_EVENTS.itemViewed, p.workspaceId, {
		workspace_id: p.workspaceId,
		item_kind: p.itemKind,
		catalog_slug: p.catalogSlug,
		source_band: p.sourceBand,
		position: p.position,
	})
}

interface ItemInstalledProps {
	workspaceId: string
	actorId: string
	itemKind: MarketplaceItemKind
	catalogSlug: string
	source: MarketplaceInstallSource
	// True when the install-card in the UI rendered a recommendation-engine
	// WHY line — used by Product Validator to correlate WHY-line copy quality
	// with install rate.
	whyLineShown: boolean
	// True when the user cleared a requires-not-met prompt (integration
	// connect or MCP install) before this install succeeded — separates the
	// friction-free installs from the "install after connecting X" installs.
	requiresPrompted: boolean
}

// Emits BOTH the generic marketplace_item_installed AND the per-kind
// derivative (agent_installed / skill_installed / tool_installed). Loops
// deliberately skip the per-kind step here — loop_installed already fires
// from trackLoopInstalled with the extended source enum, so emitting it a
// second time would double-count. See PR #5 task acceptance criteria for
// the exhaustive list of per-kind events required at launch.
export async function trackMarketplaceItemInstalled(p: ItemInstalledProps): Promise<void> {
	await capturePosthogEvent(MARKETPLACE_EVENTS.itemInstalled, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		item_kind: p.itemKind,
		catalog_slug: p.catalogSlug,
		source: p.source,
		why_line_shown: p.whyLineShown,
		requires_prompted: p.requiresPrompted,
	})
	await capturePerKindInstalledEvent(p)
}

async function capturePerKindInstalledEvent(p: ItemInstalledProps): Promise<void> {
	if (p.itemKind === 'loop') {
		// trackLoopInstalled emits loop_installed with the same source enum.
		// Skip here to avoid a double-count on the loop tab's success metric.
		return
	}
	const eventName =
		p.itemKind === 'agent'
			? MARKETPLACE_EVENTS.agentInstalled
			: p.itemKind === 'skill'
				? MARKETPLACE_EVENTS.skillInstalled
				: MARKETPLACE_EVENTS.toolInstalled
	await capturePosthogEvent(eventName, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		source: p.source,
		catalog_slug: p.catalogSlug,
	})
}

interface ItemUninstalledProps {
	workspaceId: string
	actorId: string
	itemKind: MarketplaceItemKind
	catalogSlug: string
	// Days since the audit row's installedAt — floor-divided from ms so
	// same-day uninstall is 0. Used to bucket "installed-and-immediately-
	// -uninstalled" from "installed-and-used-for-a-while" in return-intent
	// analysis.
	daysSinceInstall: number
}

export async function trackMarketplaceItemUninstalled(p: ItemUninstalledProps): Promise<void> {
	await capturePosthogEvent(MARKETPLACE_EVENTS.itemUninstalled, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		item_kind: p.itemKind,
		catalog_slug: p.catalogSlug,
		days_since_install: p.daysSinceInstall,
	})
}

interface InstallRequiresFailedProps {
	workspaceId: string
	actorId: string
	itemKind: MarketplaceItemKind
	catalogSlug: string
	// Slugs of provider integrations the workspace has not connected yet.
	missingIntegrations: string[]
	// Registry slugs of MCP servers the workspace has not installed yet.
	missingMcp: string[]
}

export async function trackMarketplaceInstallRequiresFailed(
	p: InstallRequiresFailedProps,
): Promise<void> {
	await capturePosthogEvent(MARKETPLACE_EVENTS.installRequiresFailed, p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		item_kind: p.itemKind,
		catalog_slug: p.catalogSlug,
		missing_integrations: p.missingIntegrations,
		missing_mcp: p.missingMcp,
	})
}

// Convenience: days-since-install helper used at the uninstall emit site
// so the install service doesn't recompute the same delta at every call.
export function daysSinceInstall(installedAt: Date, now: Date = new Date()): number {
	const ms = now.getTime() - installedAt.getTime()
	return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)))
}
