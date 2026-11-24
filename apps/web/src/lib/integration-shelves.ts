import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import {
	INTEGRATION_CATEGORIES,
	type IntegrationCategory,
	type IntegrationVendor,
	categoryFor,
	newProviders,
	popularProviders,
	vendorFor,
} from '@/lib/integration-catalog'

/** The pill row on Settings → Integrations: All, the two vendors, then the ten categories. */
export type IntegrationPill = 'all' | IntegrationVendor | IntegrationCategory

export const VENDOR_PILLS: readonly IntegrationVendor[] = ['Google', 'Microsoft']

/** Connected tools shown before the "Show all" button. */
export const YOUR_INTEGRATIONS_VISIBLE = 5
export const POPULAR_LIMIT = 8
export const NEW_LIMIT = 6

/** True when the pill is one of the two vendor pills rather than a category. */
export function isVendorPill(pill: IntegrationPill): pill is IntegrationVendor {
	return (VENDOR_PILLS as readonly string[]).includes(pill)
}

/** Whether a tool belongs under the pill. A tool sits in one category and at most one vendor. */
export function matchesPill(provider: string, pill: IntegrationPill): boolean {
	if (pill === 'all') return true
	return isVendorPill(pill) ? vendorFor(provider) === pill : categoryFor(provider) === pill
}

/** Whether a tool matches the page search (empty search matches everything). */
export function matchesSearch(displayName: string, needle: string): boolean {
	return !needle || displayName.toLowerCase().includes(needle)
}

/** A search or a pill other than All turns the page into one filtered list. */
export function isFiltered(needle: string, pill: IntegrationPill): boolean {
	return needle !== '' || pill !== 'all'
}

/** True when a connected tool's token predates a scope the provider now asks for. */
export function integrationNeedsReconnect(integration: IntegrationResponse | undefined): boolean {
	return Boolean(integration?.needsReconnect) && (integration?.missingScopes?.length ?? 0) > 0
}

/** Broken tools first, the rest keep their order (already A to Z). */
export function brokenFirst(
	providers: ProviderInfo[],
	activeByProvider: Map<string, IntegrationResponse[]>,
): ProviderInfo[] {
	const broken = (p: ProviderInfo) =>
		(activeByProvider.get(p.name) ?? []).some(integrationNeedsReconnect)
	return [...providers.filter(broken), ...providers.filter((p) => !broken(p))]
}

/** The tools of a shelf, in shelf order, for tools the workspace has not connected yet. */
function shelf(
	names: string[],
	byName: Map<string, ProviderInfo>,
	connected: Set<string>,
	limit: number,
): ProviderInfo[] {
	return names
		.filter((name) => !connected.has(name))
		.flatMap((name) => {
			const provider = byName.get(name)
			return provider ? [provider] : []
		})
		.slice(0, limit)
}

/** Popular: the editorial list, minus anything already connected. Empty hides the shelf. */
export function popularShelf(
	available: ProviderInfo[],
	connected: Set<string>,
	limit = POPULAR_LIMIT,
): ProviderInfo[] {
	return shelf(popularProviders(), new Map(available.map((p) => [p.name, p])), connected, limit)
}

/** New: tools added in the last 30 days, newest first, minus anything already connected. */
export function newShelf(
	available: ProviderInfo[],
	connected: Set<string>,
	now: Date = new Date(),
	limit = NEW_LIMIT,
): ProviderInfo[] {
	return shelf(newProviders(now), new Map(available.map((p) => [p.name, p])), connected, limit)
}

export interface CategoryGroup {
	category: IntegrationCategory
	providers: ProviderInfo[]
}

/**
 * Every tool not yet connected, in the catalog's category order, A to Z inside a group. Empty
 * groups are left out. The input is expected to be A to Z already.
 */
export function groupByCategory(providers: ProviderInfo[]): CategoryGroup[] {
	return INTEGRATION_CATEGORIES.map((category) => ({
		category,
		providers: providers.filter((p) => categoryFor(p.name) === category),
	})).filter((group) => group.providers.length > 0)
}
