import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordEventSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/events/record-event', () => ({ recordEvent: recordEventSpy }))

import {
	SEARCH_DEMAND_EVENT_SOURCE,
	SEARCH_DEMAND_MIN_IMPRESSIONS,
	demandWindowStart,
	deriveSearchDemand,
	indexWindowRows,
	keywordStats,
	normalizeKeyword,
	normalizePageUrl,
	writeSearchDemand,
} from '../../../../lib/integrations/providers/google-search-console/search-demand'
import {
	type GscRow,
	serializeRows,
} from '../../../../lib/integrations/providers/google-search-console/sync'

const NOW = new Date('2026-10-12T10:00:00Z')
// Sync end date is 2026-10-10, so the 30-day window is 2026-09-11 to 2026-10-10.
const WINDOW_START = '2026-09-11'
const WINDOW_END = '2026-10-10'
const PAGE = 'https://maskin.io/docs/claude-md-vs-agents-md/'

const row = (
	date: string,
	query: string,
	impressions: number,
	{ page = PAGE, clicks = 0, position = 5, country = 'usa', device = 'DESKTOP' } = {},
): GscRow => [date, page, query, country, device, impressions, clicks, 0, position]

const index = (rows: GscRow[]) => indexWindowRows([rows], WINDOW_START, WINDOW_END)

describe('demandWindowStart', () => {
	it('is the 30 days ending at the sync end date', () => {
		expect(demandWindowStart(NOW)).toBe(WINDOW_START)
	})
})

describe('normalizing', () => {
	it('lowercases, trims and collapses spaces in keywords', () => {
		expect(normalizeKeyword('  CLAUDE.md  vs   AGENTS.md ')).toBe('claude.md vs agents.md')
	})

	it('ignores case, trailing slash, query string and fragment in page URLs', () => {
		expect(normalizePageUrl('https://Maskin.io/docs/a/?utm=x#top')).toBe('https://maskin.io/docs/a')
	})
})

describe('indexWindowRows', () => {
	it('keeps only rows inside the window, across all properties', () => {
		const byQuery = indexWindowRows(
			[
				[row(WINDOW_START, 'kw', 5), row('2026-09-10', 'kw', 5)],
				[row(WINDOW_END, 'kw', 5), row('2026-10-11', 'kw', 5)],
			],
			WINDOW_START,
			WINDOW_END,
		)
		expect(byQuery.get('kw')).toHaveLength(2)
	})
})

describe('keywordStats', () => {
	it('sums impressions and clicks over countries and devices', () => {
		const stats = keywordStats(
			index([
				row('2026-10-01', 'kw', 6, { clicks: 1 }),
				row('2026-10-01', 'kw', 4, { clicks: 0, country: 'dnk', device: 'MOBILE' }),
			]),
			'kw',
		)
		expect(stats).toMatchObject({ impressions: 10, clicks: 1 })
	})

	it('weights the average position by impressions', () => {
		const stats = keywordStats(
			index([
				row('2026-10-01', 'kw', 30, { position: 2 }),
				row('2026-10-02', 'kw', 10, { position: 10 }),
			]),
			'kw',
		)
		expect(stats?.position).toBeCloseTo(4)
	})

	it('matches the keyword exactly, ignoring case and spacing', () => {
		const byQuery = index([row('2026-10-01', 'claude code', 20), row('2026-10-01', 'claude code vs cursor', 20)])
		expect(keywordStats(byQuery, '  Claude  Code ')?.impressions).toBe(20)
	})

	it('counts only the piece page when a page URL is given', () => {
		const byQuery = index([
			row('2026-10-01', 'kw', 20),
			row('2026-10-01', 'kw', 50, { page: 'https://maskin.io/other/' }),
		])
		expect(keywordStats(byQuery, 'kw', 'https://maskin.io/docs/claude-md-vs-agents-md')?.impressions).toBe(20)
		expect(keywordStats(byQuery, 'kw')?.impressions).toBe(70)
	})

	it('is null when the keyword never appeared', () => {
		expect(keywordStats(index([row('2026-10-01', 'kw', 20)]), 'other')).toBeNull()
	})
})

describe('deriveSearchDemand', () => {
	it('leaves a keyword under the impressions floor unset', () => {
		const byQuery = index([row('2026-10-01', 'kw', SEARCH_DEMAND_MIN_IMPRESSIONS - 1)])
		expect(deriveSearchDemand(byQuery, 'kw')).toBeNull()
	})

	it('derives a number at the floor', () => {
		const byQuery = index([row('2026-10-01', 'kw', SEARCH_DEMAND_MIN_IMPRESSIONS)])
		expect(typeof deriveSearchDemand(byQuery, 'kw')?.value).toBe('number')
	})
})

// ── writeSearchDemand against a fake db ────────────────────────────────────
// Two selects per run: the Search Console knowledge objects, then the live content pieces.

function makeFakeDb(properties: GscRow[][], pieces: Array<{ id: string; metadata: unknown }>) {
	const selects = [
		properties.map((rows) => ({ content: serializeRows(rows) })),
		pieces,
	]
	const updates: Array<{ set: Record<string, unknown> }> = []
	const db = {
		select: () => ({ from: () => ({ where: () => Promise.resolve(selects.shift() ?? []) }) }),
		update: () => ({
			set: (set: Record<string, unknown>) => ({
				where: () => {
					updates.push({ set })
					return Promise.resolve()
				},
			}),
		}),
	}
	return { db: db as never, updates }
}

const args = { workspaceId: 'ws-1', actorId: 'actor-1', now: NOW }

describe('writeSearchDemand', () => {
	beforeEach(() => recordEventSpy.mockReset().mockResolvedValue(undefined))

	const rows = [row('2026-10-01', 'claude.md vs agents.md', 40, { position: 3 })]
	const piece = (metadata: Record<string, unknown>) => ({ id: 'piece-1', metadata })

	it('writes the derived value with its source, and audits it as automated', async () => {
		const { db, updates } = makeFakeDb(
			[rows],
			[piece({ primary_keyword: 'claude.md vs agents.md', search_demand: 390, canonical_url: PAGE })],
		)
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 1, unchanged: 0, skipped: 0 })
		expect(updates).toHaveLength(1)
		expect(recordEventSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				action: 'updated',
				entityType: 'content',
				entityId: 'piece-1',
				data: expect.objectContaining({
					source: SEARCH_DEMAND_EVENT_SOURCE,
					field: 'search_demand',
					old: 390,
					keyword: 'claude.md vs agents.md',
					impressions: 40,
					window_start: WINDOW_START,
					window_end: WINDOW_END,
				}),
			}),
		)
	})

	it('leaves a piece with no primary_keyword match under the floor unset', async () => {
		const { db, updates } = makeFakeDb([rows], [piece({ primary_keyword: 'never searched' })])
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 0, unchanged: 0, skipped: 1 })
		expect(updates).toHaveLength(0)
		expect(recordEventSpy).not.toHaveBeenCalled()
	})

	it('does not rewrite or audit a value that has not changed', async () => {
		const current = deriveSearchDemand(index(rows), 'claude.md vs agents.md')?.value
		const { db, updates } = makeFakeDb(
			[rows],
			[
				piece({
					primary_keyword: 'claude.md vs agents.md',
					search_demand: current,
					search_demand_source: 'google-search-console',
				}),
			],
		)
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 0, unchanged: 1, skipped: 0 })
		expect(updates).toHaveLength(0)
		expect(recordEventSpy).not.toHaveBeenCalled()
	})

	it('writes nothing when no Search Console data has synced yet', async () => {
		const { db, updates } = makeFakeDb([], [piece({ primary_keyword: 'kw' })])
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 0, unchanged: 0, skipped: 1 })
		expect(updates).toHaveLength(0)
	})
})
