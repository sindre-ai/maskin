import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { recordEvent } from '../../../events/record-event'
import { logger } from '../../../logger'
import { GSC_PROVIDER, type GscRow, isoDate, parseRows, rowKey, syncEndDate } from './sync'

/** Days of Search Console rows a derivation looks at, ending at the sync end date. */
export const SEARCH_DEMAND_WINDOW_DAYS = 30
/** Below this many impressions in the window a piece is left unset rather than given derived noise. */
export const SEARCH_DEMAND_MIN_IMPRESSIONS = 10
/** Written next to search_demand so a reader can tell a derived value from a typed one. */
// A literal, not GSC_PROVIDER: sync.ts imports this file, so a top-level read of its exports would hit the import cycle.
export const SEARCH_DEMAND_SOURCE = 'google-search-console'
/** Marks the audit event of an automated write; manual edits carry no such key. */
export const SEARCH_DEMAND_EVENT_SOURCE = 'google-search-console-sync'

export interface KeywordStats {
	impressions: number
	clicks: number
	/** Impression-weighted mean of the daily average positions. */
	position: number
}

// ── Formula ────────────────────────────────────────────────────────────────

/**
 * Impressions only count when the result was actually shown, and page 1 nearly
 * always is, so deeper results undercount the searches that happened. Each row
 * is [highest average position it covers, multiplier]. Calibration heuristics,
 * not measured values: tune them here.
 */
export const POSITION_MULTIPLIERS: ReadonlyArray<readonly [number, number]> = [
	[10, 1],
	[20, 3],
	[30, 8],
	[Number.POSITIVE_INFINITY, 15],
]

function positionMultiplier(position: number): number {
	for (const [upTo, multiplier] of POSITION_MULTIPLIERS) {
		if (position <= upTo) return multiplier
	}
	return 1
}

/**
 * Turn a keyword's window totals into the search_demand scalar: the 30-day
 * impressions scaled by how deep the result sits. An estimate and a lower bound
 * on monthly searches, not comparable to third-party volumes. The one place the
 * formula lives.
 */
export function estimateSearchDemand(stats: KeywordStats): number {
	return Math.round(stats.impressions * positionMultiplier(stats.position))
}

// ── Aggregation ────────────────────────────────────────────────────────────

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`)
	d.setUTCDate(d.getUTCDate() + days)
	return isoDate(d)
}

/** First date of the 30-day window ending at the sync end date. */
export function demandWindowStart(now: Date): string {
	return addDays(syncEndDate(now), -(SEARCH_DEMAND_WINDOW_DAYS - 1))
}

export function normalizeKeyword(keyword: string): string {
	return keyword.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Compare page URLs ignoring case, a trailing slash, query string and fragment. */
export function normalizePageUrl(url: string): string {
	return url
		.trim()
		.toLowerCase()
		.replace(/[?#].*$/, '')
		.replace(/\/+$/, '')
}

/**
 * Window rows from every connected property, indexed by normalized query.
 * Properties overlap: a site connected as both `sc-domain:example.com` and
 * `https://example.com/` reports the same (date, page, query, country, device)
 * row in each, and summing both would roughly double the demand. Such a row is
 * counted once, keeping the copy with the most impressions (the wider property).
 */
export function indexWindowRows(
	rowSets: GscRow[][],
	windowStart: string,
	windowEnd: string,
): Map<string, GscRow[]> {
	const unique = new Map<string, GscRow>()
	for (const rows of rowSets) {
		for (const row of rows) {
			if (row[0] < windowStart || row[0] > windowEnd) continue
			const key = rowKey(row)
			const seen = unique.get(key)
			if (!seen || row[5] > seen[5]) unique.set(key, row)
		}
	}
	const byQuery = new Map<string, GscRow[]>()
	for (const row of unique.values()) {
		const key = normalizeKeyword(row[2])
		const bucket = byQuery.get(key)
		if (bucket) bucket.push(row)
		else byQuery.set(key, [row])
	}
	return byQuery
}

/**
 * Totals for one keyword over the indexed window, per page, summed over dates,
 * countries and devices. Never summed across pages: a query shown on several
 * of our pages would count its searches once per page.
 */
function statsByPage(rows: GscRow[]): Map<string, KeywordStats> {
	const sums = new Map<string, { impressions: number; clicks: number; positionWeighted: number }>()
	for (const row of rows) {
		const page = normalizePageUrl(row[1])
		const sum = sums.get(page) ?? { impressions: 0, clicks: 0, positionWeighted: 0 }
		sum.impressions += row[5]
		sum.clicks += row[6]
		sum.positionWeighted += row[8] * row[5]
		sums.set(page, sum)
	}
	const out = new Map<string, KeywordStats>()
	for (const [page, sum] of sums) {
		if (sum.impressions === 0) continue
		out.set(page, {
			impressions: sum.impressions,
			clicks: sum.clicks,
			position: sum.positionWeighted / sum.impressions,
		})
	}
	return out
}

/**
 * Stats for one keyword over the indexed window. The piece's own page wins when
 * it has at least the impressions floor for the query. Otherwise fall back to
 * the single page with the most impressions for it, since the demand for the
 * query is the same whichever page Google chose to show.
 */
export function keywordStats(
	byQuery: Map<string, GscRow[]>,
	keyword: string,
	pageUrl?: string | null,
): KeywordStats | null {
	const rows = byQuery.get(normalizeKeyword(keyword))
	if (!rows) return null
	const perPage = statsByPage(rows)
	const own = pageUrl ? perPage.get(normalizePageUrl(pageUrl)) : undefined
	if (own && own.impressions >= SEARCH_DEMAND_MIN_IMPRESSIONS) return own
	let best: KeywordStats | null = null
	for (const stats of perPage.values()) {
		if (!best || stats.impressions > best.impressions) best = stats
	}
	return best
}

/** The derived value, or null when the keyword has too few impressions to trust. */
export function deriveSearchDemand(
	byQuery: Map<string, GscRow[]>,
	keyword: string,
	pageUrl?: string | null,
): { value: number; stats: KeywordStats } | null {
	const stats = keywordStats(byQuery, keyword, pageUrl)
	if (!stats || stats.impressions < SEARCH_DEMAND_MIN_IMPRESSIONS) return null
	return { value: estimateSearchDemand(stats), stats }
}

// ── Writeback ──────────────────────────────────────────────────────────────

export interface SearchDemandResult {
	updated: number
	unchanged: number
	/** Under the impressions floor, or no data: left as it was. */
	skipped: number
	/** Already carries a value someone typed by hand: not overwritten. */
	preserved: number
}

/**
 * After a sync: set metadata.search_demand on every live content object that
 * has a primary_keyword, from the workspace's Search Console knowledge objects.
 * Pieces under the impressions floor are not touched, and neither is a value
 * with no source marker: a hand-entered volume beats a lower-bound estimate.
 * Each change is audited with an event carrying data.source, so it reads
 * differently from a manual edit.
 */
export async function writeSearchDemand(
	db: Database,
	args: { workspaceId: string; actorId: string; now: Date },
): Promise<SearchDemandResult> {
	const { workspaceId, actorId, now } = args
	const windowEnd = syncEndDate(now)
	const windowStart = demandWindowStart(now)

	const properties = await db
		.select({ content: objects.content })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'provider' = ${GSC_PROVIDER}`,
			),
		)
	const byQuery = indexWindowRows(
		properties.map((p) => parseRows(p.content)),
		windowStart,
		windowEnd,
	)

	const pieces = await db
		.select({ id: objects.id, metadata: objects.metadata })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'content'),
				eq(objects.status, 'live'),
				sql`btrim(coalesce(${objects.metadata}->>'primary_keyword', '')) <> ''`,
			),
		)

	const result: SearchDemandResult = { updated: 0, unchanged: 0, skipped: 0, preserved: 0 }
	for (const piece of pieces) {
		const metadata = (piece.metadata ?? {}) as Record<string, unknown>
		const keyword = String(metadata.primary_keyword)
		const canonicalUrl = typeof metadata.canonical_url === 'string' ? metadata.canonical_url : null
		const derived = deriveSearchDemand(byQuery, keyword, canonicalUrl)
		if (!derived) {
			result.skipped++
			continue
		}

		const previous = metadata.search_demand
		if (previous != null && metadata.search_demand_source !== SEARCH_DEMAND_SOURCE) {
			result.preserved++
			continue
		}
		if (previous === derived.value) {
			result.unchanged++
			continue
		}

		const patch = {
			search_demand: derived.value,
			search_demand_source: SEARCH_DEMAND_SOURCE,
			search_demand_derived_at: isoDate(now),
		}
		await db
			.update(objects)
			.set({
				metadata: sql`${objects.metadata} || ${JSON.stringify(patch)}::jsonb`,
				updatedAt: new Date(),
			})
			.where(eq(objects.id, piece.id))
		// Only the changed field, never the whole metadata blob: events feed a NOTIFY payload capped at 8KB.
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'updated',
			entityType: 'content',
			entityId: piece.id,
			data: {
				source: SEARCH_DEMAND_EVENT_SOURCE,
				field: 'search_demand',
				old: previous ?? null,
				new: derived.value,
				keyword,
				impressions: derived.stats.impressions,
				window_start: windowStart,
				window_end: windowEnd,
			},
		})
		result.updated++
	}

	logger.info('Search demand written', { workspaceId, ...result })
	return result
}
