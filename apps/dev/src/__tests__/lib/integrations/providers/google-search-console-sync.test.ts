import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runnerSpy = vi.hoisted(() => vi.fn())
const recordEventSpy = vi.hoisted(() => vi.fn())

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

	it('starts the day after the last synced date', () => {
		expect(nextRange('2026-10-08', NOW)).toEqual({ startDate: '2026-10-09', endDate: '2026-10-10' })
	})

	it('returns null when the property is already current', () => {
		expect(nextRange('2026-10-10', NOW)).toBeNull()
	})

	it('never reaches back past the 16-month window', () => {
		expect(nextRange('2020-01-01', NOW)?.startDate).toBe('2025-06-11')
	})
})

describe('mergeRows', () => {
	const row = (date: string, key: string, dim: 'url' | 'query' = 'url', clicks = 1): GscRow => [
		date,
		dim,
		key,
		10,
		clicks,
		0.1,
		3,
	]

	it('appends only rows whose date + dimension + key is new', () => {
		const existing = [row('2026-10-09', '/a')]
		const { rows, added } = mergeRows(
			existing,
			[
				row('2026-10-09', '/a', 'url', 99),
				row('2026-10-09', '/a', 'query'),
				row('2026-10-10', '/a'),
			],
			'2025-06-11',
		)
		expect(added).toBe(2)
		expect(rows).toHaveLength(3)
		// the existing row is kept, not overwritten
		expect(rows[0][4]).toBe(1)
	})

	it('is idempotent when the same rows arrive twice', () => {
		const incoming = [row('2026-10-10', '/a'), row('2026-10-10', '/b')]
		const first = mergeRows([], incoming, '2025-06-11')
		const second = mergeRows(first.rows, incoming, '2025-06-11')
		expect(second.added).toBe(0)
		expect(second.rows).toEqual(first.rows)
	})

	it('drops rows older than the window', () => {
		const { rows } = mergeRows(
			[row('2025-01-01', '/old')],
			[row('2026-10-10', '/new')],
			'2025-06-11',
		)
		expect(rows.map((r) => r[2])).toEqual(['/new'])
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

	it('gives up after five attempts', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => new Response('x', { status: 503 }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(gscFetch('https://example.test', {}, async () => {})).rejects.toThrow(/HTTP 503/)
		expect(fetchMock).toHaveBeenCalledTimes(5)
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

// ── syncGscIntegration against a recording fake db ────────────────────────
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
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
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
			const dimension = JSON.parse(String(init?.body)).dimensions[1]
			return jsonResponse({
				rows: [
					{
						keys: ['2026-10-10', dimension === 'page' ? '/p' : 'q'],
						clicks: 2,
						impressions: 20,
						ctr: 0.1,
						position: 4,
					},
				],
			})
		}),
	)
}

describe('syncGscIntegration', () => {
	beforeEach(() => {
		runnerSpy.mockReset()
		recordEventSpy.mockReset().mockResolvedValue(undefined)
	})
	afterEach(() => vi.unstubAllGlobals())

	const deps = { now: () => NOW, sleep: async () => {}, getAccessToken: async () => 'tok' }

	it('wraps the run in runIntegrationSync and flags the first run as a backfill', async () => {
		stubSearchConsole()
		const { db } = makeFakeDb()
		const outcome = await syncGscIntegration(db, integrationRow(), deps)
		expect(runnerSpy).toHaveBeenCalledWith({
			provider: 'google-search-console',
			workspaceId: 'ws-1',
			isBackfill: true,
		})
		// 2 properties x (1 url row + 1 query row), each property sees an empty fake store
		expect(outcome?.recordsWritten).toBeGreaterThan(0)
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
		})
		expect(parseRows(first.content).map((r) => r[1])).toEqual(['url', 'query'])
		// audit row for the new object, without the rows themselves
		expect(recordEventSpy).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: 'created', entityType: 'object', entityId: 'obj-1' }),
		)
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
