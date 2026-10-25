import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runnerSpy = vi.hoisted(() => vi.fn())
const recordEventSpy = vi.hoisted(() => vi.fn())
const writeDemandSpy = vi.hoisted(() => vi.fn())

vi.mock('../../../../lib/events/record-event', () => ({ recordEvent: recordEventSpy }))

vi.mock('../../../../lib/integrations/sync/runner', () => ({
	runIntegrationSync: async (
		ctx: unknown,
		work: () => Promise<{ recordsWritten: number }>,
	): Promise<{ recordsWritten: number }> => {
		runnerSpy(ctx)
		return work()
	},
}))

import {
	type GscRow,
	MAX_PROPERTY_ROWS,
	gscFetch,
	listSites,
	mergeRows,
	nextRange,
	parseRows,
	serializeRows,
	syncAllGscIntegrations,
	syncGscIntegration,
	windowStartDate,
} from '../../../../lib/integrations/providers/google-search-console/sync'

const NOW = new Date('2026-10-12T10:00:00Z')

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	})
}

describe('date window', () => {
	it('ends two days back and starts 16 months before that', () => {
		expect(windowStartDate(NOW)).toBe('2025-06-11')
		expect(nextRange(null, NOW)).toEqual({ startDate: '2025-06-11', endDate: '2026-10-10' })
	})

	it('re-fetches the trailing 14 days so a day that was not final yet is filled in', () => {
		expect(nextRange('2026-10-08', NOW)).toEqual({ startDate: '2026-09-25', endDate: '2026-10-10' })
	})

	it('still re-fetches the trailing days when the property is already current', () => {
		expect(nextRange('2026-10-10', NOW)).toEqual({ startDate: '2026-09-27', endDate: '2026-10-10' })
	})

	it('never reaches back past the 16-month window', () => {
		expect(nextRange('2020-01-01', NOW)?.startDate).toBe('2025-06-11')
	})
})

describe('mergeRows', () => {
	const row = (
		date: string,
		page: string,
		{ query = 'q', country = 'usa', device = 'DESKTOP', clicks = 1 } = {},
	): GscRow => [date, page, query, country, device, 10, clicks, 0.1, 3]

	it('keys rows on date, page, query, country and device', () => {
		const existing = [row('2026-10-09', '/a')]
		const { rows, written } = mergeRows(
			existing,
			[
				row('2026-10-09', '/b'),
				row('2026-10-09', '/a', { query: 'other' }),
				row('2026-10-09', '/a', { country: 'dnk' }),
				row('2026-10-09', '/a', { device: 'MOBILE' }),
				row('2026-10-10', '/a'),
			],
			'2025-06-11',
		)
		expect(written).toBe(5)
		expect(rows).toHaveLength(6)
	})

	it('overwrites a stored row with the re-fetched one, in place', () => {
		const existing = [row('2026-10-09', '/a'), row('2026-10-09', '/b')]
		const { rows, written } = mergeRows(
			existing,
			[row('2026-10-09', '/a', { clicks: 99 })],
			'2025-06-11',
		)
		expect(written).toBe(1)
		expect(rows).toHaveLength(2)
		expect(rows[0][6]).toBe(99)
		expect(rows[1][1]).toBe('/b')
	})

	it('is idempotent when the same rows arrive twice', () => {
		const incoming = [row('2026-10-10', '/a'), row('2026-10-10', '/b')]
		const first = mergeRows([], incoming, '2025-06-11')
		const second = mergeRows(first.rows, incoming, '2025-06-11')
		expect(second.rows).toEqual(first.rows)
		expect(second.rows).toHaveLength(2)
	})

	it('drops rows older than the window', () => {
		const { rows } = mergeRows(
			[row('2025-01-01', '/old')],
			[row('2026-10-10', '/new')],
			'2025-06-11',
		)
		expect(rows.map((r) => r[1])).toEqual(['/new'])
	})

	it('round-trips through content', () => {
		const rows = [row('2026-10-10', '/a')]
		expect(parseRows(serializeRows(rows))).toEqual(rows)
		expect(parseRows(null)).toEqual([])
		expect(parseRows('not json')).toEqual([])
	})
})

describe('gscFetch backoff', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('retries 429 with exponential backoff and then succeeds', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('slow down', { status: 429 }))
			.mockResolvedValueOnce(new Response('slow down', { status: 429 }))
			.mockResolvedValueOnce(jsonResponse({ ok: true }))
		vi.stubGlobal('fetch', fetchMock)
		const sleep = vi.fn().mockResolvedValue(undefined)

		const res = await gscFetch('https://example.test', {}, sleep)

		expect(res.ok).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000])
	})

	it('honours Retry-After', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '7' } }))
				.mockResolvedValueOnce(jsonResponse({})),
		)
		const sleep = vi.fn().mockResolvedValue(undefined)
		await gscFetch('https://example.test', {}, sleep)
		expect(sleep).toHaveBeenCalledWith(7000)
	})

	it('gives up after three attempts', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => new Response('x', { status: 429 }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(gscFetch('https://example.test', {}, async () => {})).rejects.toThrow(/HTTP 429/)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it('passes an abort signal so a hung request cannot pin the sync', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
		vi.stubGlobal('fetch', fetchMock)
		await gscFetch('https://example.test', { method: 'POST' }, async () => {})
		const init = fetchMock.mock.calls[0][1] as RequestInit
		expect(init.signal).toBeInstanceOf(AbortSignal)
		expect(init.method).toBe('POST')
	})

	it('rejects, without retrying, when the request is aborted', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
		vi.stubGlobal('fetch', fetchMock)
		await expect(gscFetch('https://example.test', {}, async () => {})).rejects.toThrow(/timed out/)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('does not retry a 403', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('no', { status: 403 }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(gscFetch('https://example.test', {}, async () => {})).rejects.toThrow(/HTTP 403/)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe('listSites', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('skips properties the account has not verified', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					siteEntry: [
						{ siteUrl: 'sc-domain:maskin.io', permissionLevel: 'siteOwner' },
						{ siteUrl: 'https://other.example/', permissionLevel: 'siteUnverifiedUser' },
					],
				}),
			),
		)
		expect(await listSites('tok')).toEqual(['sc-domain:maskin.io'])
	})
})

// ── syncGscIntegration against a recording fake db ────────────────────────────────────
// Every property looks new (the lookup finds nothing), so each run inserts.

function makeFakeDb() {
	const inserts: Record<string, unknown>[] = []
	const integrationUpdates: Record<string, unknown>[] = []
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
		}),
		insert: () => ({
			values: (v: Record<string, unknown>) => {
				inserts.push(v)
				return { returning: () => Promise.resolve([{ id: `obj-${inserts.length}` }]) }
			},
		}),
		update: () => ({
			set: (v: Record<string, unknown>) => ({
				where: () => {
					integrationUpdates.push(v)
					return Promise.resolve()
				},
			}),
		}),
	}
	return { db: db as never, inserts, integrationUpdates }
}

const integrationRow = (overrides: Record<string, unknown> = {}) => ({
	id: 'int-1',
	workspaceId: 'ws-1',
	createdBy: 'actor-1',
	status: 'active',
	config: {},
	...overrides,
})

function stubSearchConsole(opts: { failQueryFor?: string } = {}) {
	const fetchMock = vi.fn(async (url: string) => {
		if (url.endsWith('/sites')) {
			return jsonResponse({
				siteEntry: [
					{ siteUrl: 'sc-domain:a.test', permissionLevel: 'siteOwner' },
					{ siteUrl: 'sc-domain:b.test', permissionLevel: 'siteOwner' },
				],
			})
		}
		if (opts.failQueryFor && url.includes(encodeURIComponent(opts.failQueryFor))) {
			return new Response('forbidden', { status: 403 })
		}
		return jsonResponse({
			rows: [
				{
					keys: ['2026-10-10', '/p', 'q', 'usa', 'MOBILE'],
					clicks: 2,
					impressions: 20,
					ctr: 0.1,
					position: 4,
				},
			],
		})
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

describe('syncGscIntegration', () => {
	beforeEach(() => {
		runnerSpy.mockReset()
		recordEventSpy.mockReset().mockResolvedValue(undefined)
		writeDemandSpy
			.mockReset()
			.mockResolvedValue({ updated: 0, unchanged: 0, skipped: 0, preserved: 0 })
	})
	afterEach(() => vi.unstubAllGlobals())

	const deps = {
		now: () => NOW,
		sleep: async () => {},
		getAccessToken: async () => 'tok',
		writeSearchDemand: writeDemandSpy,
	}

	it('wraps the run in runIntegrationSync and flags the first run as a backfill', async () => {
		stubSearchConsole()
		const { db } = makeFakeDb()
		const outcome = await syncGscIntegration(db, integrationRow(), deps)
		expect(runnerSpy).toHaveBeenCalledWith({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			isBackfill: true,
		})
		// 2 properties x 1 row, each property sees an empty fake store
		expect(outcome?.recordsWritten).toBe(2)
	})

	it('fetches date, page, query, country and device in one request per property', async () => {
		const fetchMock = stubSearchConsole()
		const { db } = makeFakeDb()
		await syncGscIntegration(db, integrationRow(), deps)
		const queries = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith('/sites'))
		expect(queries).toHaveLength(2)
		const body = JSON.parse(String((queries[0][1] as RequestInit).body))
		expect(body.dimensions).toEqual(['date', 'page', 'query', 'country', 'device'])
	})

	// The connection's Google token can write sitemaps. Read-only is a promise of this code, so
	// pin it: the sync may list sites and POST the search analytics query, nothing else.
	it('only lists sites and queries search analytics, so it never writes to Search Console', async () => {
		const fetchMock = stubSearchConsole()
		const { db } = makeFakeDb()
		await syncGscIntegration(db, integrationRow(), deps)
		const requests = fetchMock.mock.calls.map(([url, init]) => ({
			method: (init as RequestInit | undefined)?.method ?? 'GET',
			url: String(url),
		}))
		expect(requests.length).toBeGreaterThan(0)
		for (const { method, url } of requests) {
			if (url.endsWith('/sites')) expect(method).toBe('GET')
			else {
				expect(url).toMatch(/\/searchAnalytics\/query$/)
				expect(method).toBe('POST')
			}
		}
	})

	it('writes a knowledge object with scalar-only metadata and rows in content', async () => {
		stubSearchConsole()
		const { db, inserts } = makeFakeDb()
		await syncGscIntegration(db, integrationRow(), deps)
		const first = inserts[0] as {
			type: string
			title: string
			content: string
			metadata: Record<string, unknown>
		}
		expect(first.type).toBe('knowledge')
		expect(first.title).toBe('Google Search Console: sc-domain:a.test')
		for (const value of Object.values(first.metadata)) {
			expect(['string', 'number', 'boolean']).toContain(typeof value)
		}
		expect(first.metadata).toMatchObject({
			provider: 'google-search-console',
			external_id: 'sc-domain:a.test',
			last_synced_date: '2026-10-10',
			row_count: 1,
		})
		// a clean run leaves no failure fields behind
		expect(first.metadata).not.toHaveProperty('last_error')
		expect(first.metadata).not.toHaveProperty('first_failure_at')
		expect(parseRows(first.content)).toEqual([
			['2026-10-10', '/p', 'q', 'usa', 'MOBILE', 20, 2, 0.1, 4],
		])
		// audit row for the new object, without the rows themselves
		expect(recordEventSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: 'created', entityType: 'object', entityId: 'obj-1' }),
		)
	})

	it('writes search_demand for the workspace once the sync has succeeded', async () => {
		stubSearchConsole()
		const { db } = makeFakeDb()
		await syncGscIntegration(db, integrationRow(), deps)
		expect(writeDemandSpy).toHaveBeenCalledTimes(1)
		expect(writeDemandSpy).toHaveBeenCalledWith(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			now: NOW,
		})
	})

	it('does not fail the sync when the search_demand writeback throws', async () => {
		stubSearchConsole()
		writeDemandSpy.mockRejectedValue(new Error('boom'))
		const { db, integrationUpdates } = makeFakeDb()
		await expect(syncGscIntegration(db, integrationRow(), deps)).resolves.toMatchObject({
			recordsWritten: 2,
		})
		// the sync still recorded itself as complete
		expect(integrationUpdates.length).toBeGreaterThan(0)
	})

	it('does not write search_demand when the sync fails', async () => {
		stubSearchConsole({ failQueryFor: 'sc-domain:a.test' })
		const { db } = makeFakeDb()
		await expect(syncGscIntegration(db, integrationRow(), deps)).rejects.toThrow()
		expect(writeDemandSpy).not.toHaveBeenCalled()
	})

	it('skips an integration that is already current for the day', async () => {
		stubSearchConsole()
		const { db } = makeFakeDb()
		const row = integrationRow({ config: { gsc: { lastSyncedDate: '2026-10-10' } } })
		expect(await syncGscIntegration(db, row, deps)).toBeNull()
		expect(runnerSpy).not.toHaveBeenCalled()
	})

	it('keeps syncing the other properties when one fails, then reports the run as failed', async () => {
		stubSearchConsole({ failQueryFor: 'sc-domain:a.test' })
		const { db, inserts, integrationUpdates } = makeFakeDb()
		await expect(syncGscIntegration(db, integrationRow(), deps)).rejects.toThrow(/sc-domain:a.test/)
		expect(inserts.map((i) => (i as { title: string }).title)).toContain(
			'Google Search Console: sc-domain:b.test',
		)
		// a failure inside 24h records the streak but leaves the status alone
		const patch = integrationUpdates.at(-1) as { status?: string }
		expect(patch.status).toBeUndefined()
	})

	it('logs a failed property to its own object as scalar last_error and first_failure_at', async () => {
		stubSearchConsole({ failQueryFor: 'sc-domain:a.test' })
		const { db, inserts } = makeFakeDb()
		await expect(syncGscIntegration(db, integrationRow(), deps)).rejects.toThrow()
		const failed = inserts.find(
			(i) => (i as { title: string }).title === 'Google Search Console: sc-domain:a.test',
		) as { metadata: Record<string, unknown>; content: string }
		expect(failed.metadata).toMatchObject({
			external_id: 'sc-domain:a.test',
			row_count: 0,
			last_error: expect.stringContaining('HTTP 403'),
			first_failure_at: NOW.toISOString(),
		})
		expect(failed.metadata).not.toHaveProperty('last_synced_date')
		expect(parseRows(failed.content)).toEqual([])
		// the healthy property carries no error
		const healthy = inserts.find(
			(i) => (i as { title: string }).title === 'Google Search Console: sc-domain:b.test',
		) as { metadata: Record<string, unknown> }
		expect(healthy.metadata).not.toHaveProperty('last_error')
	})

	it('stops fetching and fails one property at the row cap while the other still syncs', async () => {
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/sites')) {
				return jsonResponse({
					siteEntry: [
						{ siteUrl: 'sc-domain:a.test', permissionLevel: 'siteOwner' },
						{ siteUrl: 'sc-domain:b.test', permissionLevel: 'siteOwner' },
					],
				})
			}
			if (!url.includes(encodeURIComponent('sc-domain:a.test'))) {
				return jsonResponse({
					rows: [
						{
							keys: ['2026-10-10', '/p', 'q', 'usa', 'MOBILE'],
							clicks: 2,
							impressions: 20,
							ctr: 0.1,
							position: 4,
						},
					],
				})
			}
			// Property a never runs out of full pages of unique rows.
			const { startRow } = JSON.parse(String(init?.body)) as { startRow: number }
			return jsonResponse({
				rows: Array.from({ length: 25_000 }, (_, i) => ({
					keys: ['2026-10-10', `/p${startRow + i}`, 'q', 'usa', 'MOBILE'],
					clicks: 1,
					impressions: 10,
					ctr: 0.1,
					position: 4,
				})),
			})
		})
		vi.stubGlobal('fetch', fetchMock)
		const { db, inserts } = makeFakeDb()

		await expect(syncGscIntegration(db, integrationRow(), deps)).rejects.toThrow(
			'sc-domain:a.test: too large',
		)

		// pagination stopped just past the cap, not at the 2.5M guard
		const pagesForA = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes(encodeURIComponent('sc-domain:a.test')),
		)
		expect(pagesForA).toHaveLength(MAX_PROPERTY_ROWS / 25_000 + 1)

		const over = inserts.find(
			(i) => (i as { title: string }).title === 'Google Search Console: sc-domain:a.test',
		) as { metadata: Record<string, unknown>; content: string }
		expect(over.metadata).toMatchObject({
			last_error: 'too large',
			first_failure_at: NOW.toISOString(),
			row_count: 0,
		})
		expect(parseRows(over.content)).toEqual([])

		const healthy = inserts.find(
			(i) => (i as { title: string }).title === 'Google Search Console: sc-domain:b.test',
		) as { metadata: Record<string, unknown> }
		expect(healthy.metadata).toMatchObject({ row_count: 1, last_synced_date: '2026-10-10' })
		expect(healthy.metadata).not.toHaveProperty('last_error')
	})

	it('flips the integration to error once failures persist past 24 hours', async () => {
		stubSearchConsole({ failQueryFor: 'sc-domain:a.test' })
		const { db, integrationUpdates } = makeFakeDb()
		const row = integrationRow({
			config: { gsc: { firstFailureAt: '2026-10-11T08:00:00.000Z' } },
		})
		await expect(syncGscIntegration(db, row, deps)).rejects.toThrow()
		expect((integrationUpdates.at(-1) as { status?: string }).status).toBe('error')
		expect(recordEventSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				entityType: 'integration',
				data: expect.objectContaining({ status: 'error' }),
			}),
		)
	})

	it('returns an errored integration to active after a clean run', async () => {
		stubSearchConsole()
		const { db, integrationUpdates } = makeFakeDb()
		const row = integrationRow({
			status: 'error',
			config: { gsc: { firstFailureAt: '2026-10-09T08:00:00.000Z' } },
		})
		await syncGscIntegration(db, row, deps)
		expect((integrationUpdates.at(-1) as { status?: string }).status).toBe('active')
	})
})

describe('syncAllGscIntegrations', () => {
	it('is exported for the scheduler', () => {
		expect(typeof syncAllGscIntegrations).toBe('function')
	})
})
