/**
 * marketplace-pick.ts — the one Marketplace flow a person who switched picks on may see under their
 * summary email.
 *
 * A plain rule, no AI call: a Marketplace flow in the same category (the catalog's use_case) as a
 * flow the workspace already has, that the workspace has not installed, that is not retired and
 * that the person has not marked "Not useful". With no match there is no pick: never a weak one.
 * The catalog stores no price, setup or "included" fact, so the block says nothing about cost and
 * points at the flow's own Marketplace page instead.
 *
 * The send rules (opt-in, never in the first three mails, one a week, never on its own) live in
 * the email scheduler; this file only chooses the flow.
 */
import type { Database } from '@maskin/db'
import { installedLoops, marketplaceLoops } from '@maskin/db/schema'
import { eq, isNull } from 'drizzle-orm'

/** One pick at most every 7 days, counted in the person's local dates. */
export const PICK_MIN_GAP_DAYS = 7

export interface CatalogFlow {
	id: string
	name: string
	slug: string
	description: string
	useCase: string | null
}

export interface MarketplacePick {
	flow: CatalogFlow
	/** The "Why you see this" sentence, without the prefix. */
	why: string
}

function category(useCase: string | null): string | null {
	const c = useCase?.trim().toLowerCase()
	return c ? c : null
}

/**
 * Pure: the pick, or null. `installed` is every flow the workspace has installed (retired ones
 * too), `catalog` the flows on offer, `dismissed` the flow ids the person marked "Not useful".
 * Deterministic: the first match by slug.
 */
export function choosePick(input: {
	installed: CatalogFlow[]
	catalog: CatalogFlow[]
	dismissed: readonly string[]
}): MarketplacePick | null {
	const installedIds = new Set(input.installed.map((f) => f.id))
	const dismissed = new Set(input.dismissed)
	const byCategory = new Map<string, CatalogFlow>()
	for (const flow of [...input.installed].sort((a, b) => a.name.localeCompare(b.name))) {
		const cat = category(flow.useCase)
		if (cat && !byCategory.has(cat)) byCategory.set(cat, flow)
	}
	const candidates = input.catalog
		.filter((f) => !installedIds.has(f.id) && !dismissed.has(f.id))
		.sort((a, b) => a.slug.localeCompare(b.slug))
	for (const flow of candidates) {
		const cat = category(flow.useCase)
		const have = cat ? byCategory.get(cat) : undefined
		if (!cat || !have) continue
		return {
			flow,
			why: `you already use ${have.name}, and this is another flow for ${flow.useCase?.trim()}.`,
		}
	}
	return null
}

/** Reads the workspace's installed flows and the live catalog, then applies choosePick. */
export async function loadMarketplacePick(
	db: Database,
	workspaceId: string,
	dismissed: readonly string[],
): Promise<MarketplacePick | null> {
	const columns = {
		id: marketplaceLoops.id,
		name: marketplaceLoops.name,
		slug: marketplaceLoops.slug,
		description: marketplaceLoops.description,
		useCase: marketplaceLoops.useCase,
	}
	const installed = await db
		.select(columns)
		.from(installedLoops)
		.innerJoin(marketplaceLoops, eq(installedLoops.sourceLoopId, marketplaceLoops.id))
		.where(eq(installedLoops.workspaceId, workspaceId))
	if (installed.length === 0) return null
	const catalog = await db
		.select(columns)
		.from(marketplaceLoops)
		.where(isNull(marketplaceLoops.retiredAt))
	return choosePick({ installed, catalog, dismissed })
}

/** Whole local days between two ISO dates (yyyy-mm-dd). */
function daysBetween(from: string, to: string): number {
	return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Pure: a pick may join a mail only if none went out in the last 7 days. */
export function pickWeekOpen(lastPickOn: string | null, localDate: string): boolean {
	return lastPickOn === null || daysBetween(lastPickOn, localDate) >= PICK_MIN_GAP_DAYS
}
