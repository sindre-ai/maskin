import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordEventSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/events/record-event', () => ({ recordEvent: recordEventSpy }))

import { config } from '../../../../lib/integrations/providers/google-search-console/config'
import {
	SEARCH_DEMAND_EVENT_SOURCE,
	SEARCH_DEMAND_MIN_IMPRESSIONS,
	demandWindowStart,
	deriveSearchDemand,
	estimateSearchDemand,
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

	it('counts a row once when overlapping properties both report it', () => {
		const domainProperty = [row('2026-10-01', 'kw', 40), row('2026-10-02', 'kw', 10)]
		const urlPrefixProperty = [row('2026-10-01', 'kw', 40), row('2026-10-03', 'kw', 6)]
		const byQuery = indexWindowRows([domainProperty, urlPrefixProperty], WINDOW_START, WINDOW_END)
		expect(byQuery.get('kw')).toHaveLength(3)
		expect(keywordStats(byQuery, 'kw', PAGE)?.impressions).toBe(56)
	})

	it('keeps the copy with the most impressions when overlapping properties disagree', () => {
		const byQuery = indexWindowRows(
			[[row('2026-10-01', 'kw', 30)], [row('2026-10-01', 'kw', 45)]],
			WINDOW_START,
			WINDOW_END,
		)
		expect(keywordStats(byQuery, 'kw', PAGE)?.impressions).toBe(45)
	})

	it('still separates rows that differ by country or device', () => {
		const byQuery = indexWindowRows(
			[
				[
					row('2026-10-01', 'kw', 5, { country: 'usa' }),
					row('2026-10-01', 'kw', 5, { country: 'nor' }),
				],
			],
			WINDOW_START,
			WINDOW_END,
		)
		expect(byQuery.get('kw')).toHaveLength(2)
	})
})

describe('estimateSearchDemand', () => {
	const at = (position: number) => estimateSearchDemand({ impressions: 100, clicks: 0, position })

	it('keeps impressions as they are anywhere on page 1', () => {
		expect(at(1)).toBe(100)
		expect(at(10)).toBe(100)
	})

	it('scales results below page 1 by a fixed multiplier', () => {
		expect(at(10.5)).toBe(300)
		expect(at(20)).toBe(300)
		expect(at(25)).toBe(800)
		expect(at(30)).toBe(800)
	})

	it('caps the multiplier at 15 however deep the result sits', () => {
		expect(at(30.1)).toBe(1500)
		expect(at(90)).toBe(1500)
	})
})

describe('integration description', () => {
	it('states the impressions floor, the estimate caveat and that hand values are kept', () => {
		expect(config.description).toContain(`fewer than ${SEARCH_DEMAND_MIN_IMPRESSIONS} impressions`)
		expect(config.description).toContain('lower bound')
		expect(config.description).toContain('never overwritten')
	})
})

describe('keywordStats', () => {
	it('sums impressions and clicks over dates, countries and devices', () => {
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
		const byQuery = index([
			row('2026-10-01', 'claude code', 20),
			row('2026-10-01', 'claude code vs cursor', 20),
		])
		expect(keywordStats(byQuery, '  Claude  Code ')?.impressions).toBe(20)
	})

	it('counts only the piece page when it has enough impressions', () => {
		const byQuery = index([
			row('2026-10-01', 'kw', 20),
			row('2026-10-01', 'kw', 50, { page: 'https://maskin.io/other/' }),
		])
		expect(
			keywordStats(byQuery, 'kw', 'https://maskin.io/docs/claude-md-vs-agents-md')?.impressions,
		).toBe(20)
	})

	it('falls back to the busiest page, never a sum across pages, under the floor', () => {
		const byQuery = index([
			row('2026-10-01', 'kw', SEARCH_DEMAND_MIN_IMPRESSIONS - 1),
			row('2026-10-01', 'kw', 50, { page: 'https://maskin.io/other-a/' }),
			row('2026-10-02', 'kw', 30, { page: 'https://maskin.io/other-b/' }),
		])
		expect(keywordStats(byQuery, 'kw', PAGE)?.impressions).toBe(50)
	})

	it('uses the busiest page when the piece has no page URL', () => {
		const byQuery = index([
			row('2026-10-01', 'kw', 20),
			row('2026-10-01', 'kw', 50, { page: 'https://maskin.io/other/' }),
		])
		expect(keywordStats(byQuery, 'kw')?.impressions).toBe(50)
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
	const selects = [properties.map((rows) => ({ content: serializeRows(rows) })), pieces]
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
			[piece({ primary_keyword: 'claude.md vs agents.md', canonical_url: PAGE })],
		)
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 1, unchanged: 0, skipped: 0, preserved: 0 })
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
					old: null,
					new: 40,
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
		expect(result).toEqual({ updated: 0, unchanged: 0, skipped: 1, preserved: 0 })
		expect(updates).toHaveLength(0)
		expect(recordEventSpy).not.toHaveBeenCalled()
	})

	it('does not overwrite a value that was typed by hand', async () => {
		const { db, updates } = makeFakeDb(
			[rows],
			[
				piece({
					primary_keyword: 'claude.md vs agents.md',
					search_demand: 390,
					canonical_url: PAGE,
				}),
			],
		)
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 0, unchanged: 0, skipped: 0, preserved: 1 })
		expect(updates).toHaveLength(0)
		expect(recordEventSpy).not.toHaveBeenCalled()
	})

	it('refreshes a value the sync wrote earlier and audits the old one', async () => {
		const { db, updates } = makeFakeDb(
			[rows],
			[
				piece({
					primary_keyword: 'claude.md vs agents.md',
					search_demand: 12,
					search_demand_source: 'google-search-console',
					canonical_url: PAGE,
				}),
			],
		)
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 1, unchanged: 0, skipped: 0, preserved: 0 })
		expect(updates).toHaveLength(1)
		expect(recordEventSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ data: expect.objectContaining({ old: 12, new: 40 }) }),
		)
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
		expect(result).toEqual({ updated: 0, unchanged: 1, skipped: 0, preserved: 0 })
		expect(updates).toHaveLength(0)
		expect(recordEventSpy).not.toHaveBeenCalled()
	})

	it('writes nothing when no Search Console data has synced yet', async () => {
		const { db, updates } = makeFakeDb([], [piece({ primary_keyword: 'kw' })])
		const result = await writeSearchDemand(db, args)
		expect(result).toEqual({ updated: 0, unchanged: 0, skipped: 1, preserved: 0 })
		expect(updates).toHaveLength(0)
	})
})
