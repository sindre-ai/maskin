import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runnerSpy = vi.hoisted(() => vi.fn())
const recordEventSpy = vi.hoisted(() => vi.fn())
const inspectSpy = vi.hoisted(() => vi.fn())

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
	INDEX_ROW_COLUMNS,
	type IndexRow,
	deriveIndexState,
	inspectUrl,
	parseIndexRows,
	propertyForUrl,
	serializeIndexRows,
} from '../../../../lib/integrations/providers/google-search-console/index-status'
import { syncAllGscIntegrations } from '../../../../lib/integrations/providers/google-search-console/sync'

const NOW = new Date('2026-10-12T10:00:00Z')

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	})
}

// Real answers from the URL Inspection API for maskin.io, 22 Oct 2026.
const HOMEPAGE_PASS = {
	verdict: 'PASS',
	coverageState: 'Submitted and indexed',
	robotsTxtState: 'ALLOWED',
	indexingState: 'INDEXING_ALLOWED',
	lastCrawlTime: '2026-10-20T23:07:23Z',
	pageFetchState: 'SUCCESSFUL',
	googleCanonical: 'https://maskin.io/',
	userCanonical: 'https://maskin.io/',
}
const UNKNOWN_TO_GOOGLE = {
	verdict: 'NEUTRAL',
	coverageState: 'URL is unknown to Google',
	robotsTxtState: 'ROBOTS_TXT_STATE_UNSPECIFIED',
	indexingState: 'INDEXING_STATE_UNSPECIFIED',
	pageFetchState: 'PAGE_FETCH_STATE_UNSPECIFIED',
}
const CRAWLED_NOT_INDEXED = {
	verdict: 'NEUTRAL',
	coverageState: 'Crawled - currently not indexed',
	robotsTxtState: 'ALLOWED',
	indexingState: 'INDEXING_ALLOWED',
	lastCrawlTime: '2026-10-14T08:00:00Z',
	pageFetchState: 'SUCCESSFUL',
	userCanonical: 'https://maskin.io/docs/a/',
}

describe('deriveIndexState', () => {
	it('maps PASS with Google choosing the page itself to indexed', () => {
		expect(deriveIndexState('https://maskin.io/', HOMEPAGE_PASS)).toBe('indexed')
	})

	it('maps PASS with no Google canonical to indexed', () => {
		expect(deriveIndexState('https://maskin.io/a', { verdict: 'PASS' })).toBe('indexed')
	})

	it('ignores case, trailing slash and query when comparing the canonical', () => {
		expect(
			deriveIndexState('https://maskin.io/Docs/a', {
				verdict: 'PASS',
				googleCanonical: 'https://maskin.io/docs/a/?utm=x',
			}),
		).toBe('indexed')
	})

	it('maps PASS with a different Google canonical to canonical_elsewhere', () => {
		expect(
			deriveIndexState('https://maskin.io/a', {
				verdict: 'PASS',
				googleCanonical: 'https://maskin.io/b',
			}),
		).toBe('canonical_elsewhere')
	})

	it('maps NEUTRAL with a crawl but no index to not_indexed', () => {
		expect(deriveIndexState('https://maskin.io/docs/a/', CRAWLED_NOT_INDEXED)).toBe('not_indexed')
	})

	it('maps a URL unknown to Google (no crawl time, no canonical) to not_indexed', () => {
		expect(deriveIndexState('https://maskin.io/small-business/', UNKNOWN_TO_GOOGLE)).toBe(
			'not_indexed',
		)
	})

	it('maps PARTIAL and FAIL to not_indexed', () => {
		expect(deriveIndexState('https://maskin.io/a', { verdict: 'PARTIAL' })).toBe('not_indexed')
		expect(deriveIndexState('https://maskin.io/a', { verdict: 'FAIL' })).toBe('not_indexed')
	})
})

describe('propertyForUrl', () => {
	it('matches sc-domain on the host, www and any subdomain', () => {
		const props = ['sc-domain:maskin.io']
		expect(propertyForUrl('https://maskin.io/a', props)).toBe('sc-domain:maskin.io')
		expect(propertyForUrl('http://maskin.io/a', props)).toBe('sc-domain:maskin.io')
		expect(propertyForUrl('https://www.maskin.io/a', props)).toBe('sc-domain:maskin.io')
		expect(propertyForUrl('https://blog.maskin.io/a', props)).toBe('sc-domain:maskin.io')
		expect(propertyForUrl('https://a.b.maskin.io/', props)).toBe('sc-domain:maskin.io')
	})

	it('needs a dot boundary: notmaskin.io is not maskin.io', () => {
		const props = ['sc-domain:maskin.io']
		expect(propertyForUrl('https://notmaskin.io/a', props)).toBeNull()
		expect(propertyForUrl('https://maskin.io.evil.test/a', props)).toBeNull()
		expect(propertyForUrl('https://xmaskin.io', props)).toBeNull()
	})

	it('is case-insensitive on the host', () => {
		expect(propertyForUrl('https://WWW.Maskin.IO/A', ['sc-domain:MASKIN.io'])).toBe(
			'sc-domain:MASKIN.io',
		)
	})

	it('matches a URL-prefix property by prefix, and http is not https', () => {
		const props = ['https://maskin.io/']
		expect(propertyForUrl('https://maskin.io/docs/a', props)).toBe('https://maskin.io/')
		expect(propertyForUrl('http://maskin.io/docs/a', props)).toBeNull()
		expect(propertyForUrl('https://www.maskin.io/docs/a', props)).toBeNull()
	})

	it('treats a bare host and its trailing-slash form as the same page', () => {
		expect(propertyForUrl('https://maskin.io', ['https://maskin.io/'])).toBe('https://maskin.io/')
		expect(propertyForUrl('https://maskin.io/docs', ['https://maskin.io/docs/'])).toBe(
			'https://maskin.io/docs/',
		)
	})

	it('does not let a path prefix leak into a sibling path', () => {
		expect(propertyForUrl('https://maskin.io/blog/a', ['https://maskin.io/docs/'])).toBeNull()
	})

	it('picks the sc-domain property when several cover the URL', () => {
		const props = ['https://maskin.io/', 'sc-domain:maskin.io', 'https://maskin.io/docs/']
		expect(propertyForUrl('https://maskin.io/docs/a', props)).toBe('sc-domain:maskin.io')
	})

	it('picks the most specific URL-prefix property when no sc-domain covers it', () => {
		const props = ['https://maskin.io/', 'https://maskin.io/docs/']
		expect(propertyForUrl('https://maskin.io/docs/a', props)).toBe('https://maskin.io/docs/')
	})

	it('returns null when no property covers the URL, or the URL is not a web URL', () => {
		const props = ['sc-domain:maskin.io', 'https://vaerksted.ai/']
		expect(propertyForUrl('https://example.com/a', props)).toBeNull()
		expect(propertyForUrl('not a url', props)).toBeNull()
		expect(propertyForUrl('mailto:a@maskin.io', props)).toBeNull()
		expect(propertyForUrl('https://maskin.io/a', [])).toBeNull()
	})
})

describe('index rows content', () => {
	const row: IndexRow = {
		url: 'https://maskin.io/',
		source: 'tracked',
		checked_at: '2026-10-12T10:00:00.000Z',
		state: 'indexed',
		verdict: 'PASS',
		coverageState: 'Submitted and indexed',
		lastCrawlTime: null,
		robotsTxtState: 'ALLOWED',
		indexingState: 'INDEXING_ALLOWED',
		pageFetchState: 'SUCCESSFUL',
		googleCanonical: 'https://maskin.io/',
		userCanonical: 'https://maskin.io/',
		state_since: '2026-10-12',
		error: null,
	}

	it('stores a columns list and one array per row, in column order', () => {
		const parsed = JSON.parse(serializeIndexRows([row]))
		expect(parsed.columns).toEqual([...INDEX_ROW_COLUMNS])
		expect(parsed.columns).toEqual([
			'url',
			'source',
			'checked_at',
			'state',
			'verdict',
			'coverageState',
			'lastCrawlTime',
			'robotsTxtState',
			'indexingState',
			'pageFetchState',
			'googleCanonical',
			'userCanonical',
			'state_since',
			'error',
		])
		expect(parsed.rows).toHaveLength(1)
		expect(parsed.rows[0][0]).toBe('https://maskin.io/')
	})

	it('round-trips through content', () => {
		expect(parseIndexRows(serializeIndexRows([row]))).toEqual([row])
	})

	it('reads nothing from empty, broken or foreign content', () => {
		expect(parseIndexRows(null)).toEqual([])
		expect(parseIndexRows('not json')).toEqual([])
		expect(parseIndexRows(JSON.stringify({ rows: [] }))).toEqual([])
	})
})

describe('inspectUrl', () => {
	afterEach(() => vi.unstubAllGlobals())

	const indexResult = (indexStatusResult: unknown) =>
		jsonResponse({ inspectionResult: { indexStatusResult } })

	it('posts inspectionUrl and siteUrl to the v1 inspect host with the bearer token', async () => {
		const fetchMock = vi.fn().mockResolvedValue(indexResult(HOMEPAGE_PASS))
		vi.stubGlobal('fetch', fetchMock)

		const result = await inspectUrl(
			'tok',
			'sc-domain:maskin.io',
			'https://maskin.io/',
			async () => {},
		)

		expect(result).toEqual(HOMEPAGE_PASS)
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect')
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
		expect(JSON.parse(String(init.body))).toEqual({
			inspectionUrl: 'https://maskin.io/',
			siteUrl: 'sc-domain:maskin.io',
		})
	})

	it('returns the fields for a URL unknown to Google, with no crawl time or canonical', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(indexResult(UNKNOWN_TO_GOOGLE)))
		const result = await inspectUrl(
			'tok',
			'sc-domain:maskin.io',
			'https://maskin.io/x',
			async () => {},
		)
		expect(result.coverageState).toBe('URL is unknown to Google')
		expect(result.lastCrawlTime).toBeUndefined()
		expect(result.googleCanonical).toBeUndefined()
	})

	it('throws on a 400 without retrying', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('not under property', { status: 400 }))
		vi.stubGlobal('fetch', fetchMock)
		await expect(
			inspectUrl('tok', 'sc-domain:maskin.io', 'https://other.test/', async () => {}),
		).rejects.toThrow(/HTTP 400/)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('retries a 5xx with backoff, then throws after three attempts', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => new Response('down', { status: 503 }))
		vi.stubGlobal('fetch', fetchMock)
		const sleep = vi.fn().mockResolvedValue(undefined)
		await expect(
			inspectUrl('tok', 'sc-domain:maskin.io', 'https://maskin.io/', sleep),
		).rejects.toThrow(/HTTP 503/)
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000])
	})

	it('throws when the answer carries no indexStatusResult', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ inspectionResult: {} })))
		await expect(
			inspectUrl('tok', 'sc-domain:maskin.io', 'https://maskin.io/', async () => {}),
		).rejects.toThrow(/no indexStatusResult/)
	})
})

// ── The hook in syncAllGscIntegrations ──────────────────────────────────────────────

describe('syncAllGscIntegrations and the inspection step', () => {
	const rows = [
		{ id: 'int-1', workspaceId: 'ws-1', createdBy: 'actor-1', status: 'active', config: {} },
	]
	beforeEach(() => {
		runnerSpy.mockReset()
		recordEventSpy.mockReset().mockResolvedValue(undefined)
		inspectSpy.mockReset().mockResolvedValue(null)
	})
	afterEach(() => vi.unstubAllGlobals())

	function stubGoogle(sitesStatus = 200) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.endsWith('/sites')
					? sitesStatus === 200
						? jsonResponse({ siteEntry: [] })
						: new Response('forbidden', { status: sitesStatus })
					: jsonResponse({}),
			),
		)
	}

	// The sync writes to the integrations table only; the inspection step is injected.
	const writes: unknown[] = []
	const writingDb = {
		select: () => ({
			from: () => ({
				where: () => {
					const result = Promise.resolve(rows) as Promise<typeof rows> & {
						limit: () => Promise<[]>
					}
					result.limit = () => Promise.resolve([])
					return result
				},
			}),
		}),
		update: () => ({
			set: (v: unknown) => ({
				where: () => {
					writes.push(v)
					return Promise.resolve()
				},
			}),
		}),
	} as never

	const deps = {
		now: () => NOW,
		sleep: async () => {},
		getAccessToken: async () => 'tok',
		writeSearchDemand: vi.fn().mockResolvedValue({}),
		inspectIndexStatus: inspectSpy,
	}

	it('inspects after a successful sync, with the run time and a lazy token getter', async () => {
		stubGoogle()
		await syncAllGscIntegrations(writingDb, deps)

		expect(inspectSpy).toHaveBeenCalledTimes(1)
		const [, row, inspectDeps] = inspectSpy.mock.calls[0]
		expect(row).toMatchObject({ id: 'int-1', workspaceId: 'ws-1' })
		expect(inspectDeps.now).toEqual(NOW)
		await expect(inspectDeps.getAccessToken()).resolves.toBe('tok')
	})

	it('emits one integration_sync_completed run per daily sync: the inspection is not wrapped in the runner', async () => {
		stubGoogle()
		await syncAllGscIntegrations(writingDb, deps)
		expect(runnerSpy).toHaveBeenCalledTimes(1)
	})

	it('still inspects when the sync is already current for the day (zero sync calls)', async () => {
		stubGoogle()
		const current = [
			{
				...rows[0],
				config: { gsc: { lastSyncedDate: '2026-10-10', backfilledAt: '2026-10-01T00:00:00Z' } },
			},
		]
		const currentDb = {
			select: () => ({ from: () => ({ where: () => Promise.resolve(current) }) }),
		} as never
		await syncAllGscIntegrations(currentDb, deps)
		expect(runnerSpy).not.toHaveBeenCalled()
		expect(inspectSpy).toHaveBeenCalledTimes(1)
	})

	it('makes no inspection when the main sync failed', async () => {
		stubGoogle(403)
		await syncAllGscIntegrations(writingDb, deps)
		expect(runnerSpy).toHaveBeenCalledTimes(1)
		expect(inspectSpy).not.toHaveBeenCalled()
	})

	it('makes no inspection when the token is bad (the sync cannot get one)', async () => {
		stubGoogle()
		await syncAllGscIntegrations(writingDb, {
			...deps,
			getAccessToken: async () => {
				throw new Error('invalid_grant')
			},
		})
		expect(inspectSpy).not.toHaveBeenCalled()
	})

	it('survives an inspection failure and does not touch the integration', async () => {
		stubGoogle()
		writes.length = 0
		inspectSpy.mockRejectedValueOnce(new Error('boom'))
		await expect(syncAllGscIntegrations(writingDb, deps)).resolves.toBeUndefined()
		// Only the sync's own state write (last_synced_date); nothing flips the status.
		expect(writes).toHaveLength(1)
		expect(writes[0]).not.toHaveProperty('status')
	})

	it('skips a postInstall error row exactly as before', async () => {
		stubGoogle()
		const broken = [{ ...rows[0], status: 'error', config: {} }]
		const brokenDb = {
			select: () => ({ from: () => ({ where: () => Promise.resolve(broken) }) }),
		} as never
		await syncAllGscIntegrations(brokenDb, deps)
		expect(inspectSpy).not.toHaveBeenCalled()
		expect(runnerSpy).not.toHaveBeenCalled()
	})
})
