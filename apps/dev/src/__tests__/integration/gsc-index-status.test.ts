import { events, integrations, objects } from '@maskin/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	GSC_INDEX_PROVIDER,
	type IndexRow,
	inspectIndexStatus,
	parseIndexRows,
	serializeIndexRows,
} from '../../lib/integrations/providers/google-search-console/index-status'
import { writeSearchDemand } from '../../lib/integrations/providers/google-search-console/search-demand'
import {
	GSC_PROVIDER,
	type GscRow,
	parseRows,
	serializeRows,
	syncAllGscIntegrations,
	syncGscIntegration,
} from '../../lib/integrations/providers/google-search-console/sync'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const SITE = 'sc-domain:gsc-index.test'
const HOME = 'https://gsc-index.test/'
const UNKNOWN = 'https://www.gsc-index.test/small-business/'
const ELSEWHERE = 'https://gsc-index.test/old'
const BROKEN = 'https://gsc-index.test/broken'
const OUTSIDE = 'https://other.example/page'

const DAY1 = new Date('2026-10-12T10:00:00Z')
const DAY1_LATE = new Date('2026-10-12T16:00:00Z')
// 23 hours later, but the next calendar date.
const DAY2 = new Date('2026-10-13T09:00:00Z')
const DAY2_LATE = new Date('2026-10-13T16:00:00Z')
const DAY3 = new Date('2026-10-14T09:00:00Z')
// 7 calendar dates after DAY1.
const DAY8 = new Date('2026-10-19T09:00:00Z')

type Answer = Record<string, unknown> | { status: number }

const PASS = {
	verdict: 'PASS',
	coverageState: 'Submitted and indexed',
	robotsTxtState: 'ALLOWED',
	indexingState: 'INDEXING_ALLOWED',
	lastCrawlTime: '2026-10-11T23:07:23Z',
	pageFetchState: 'SUCCESSFUL',
	googleCanonical: HOME,
	userCanonical: HOME,
}
const UNKNOWN_TO_GOOGLE = {
	verdict: 'NEUTRAL',
	coverageState: 'URL is unknown to Google',
	robotsTxtState: 'ROBOTS_TXT_STATE_UNSPECIFIED',
	indexingState: 'INDEXING_STATE_UNSPECIFIED',
	pageFetchState: 'PAGE_FETCH_STATE_UNSPECIFIED',
}

function defaultAnswers(): Record<string, Answer> {
	return {
		[HOME]: PASS,
		[UNKNOWN]: UNKNOWN_TO_GOOGLE,
		[ELSEWHERE]: { ...PASS, googleCanonical: 'https://gsc-index.test/new' },
		[BROKEN]: { status: 400 },
	}
}

/** Stubs Google. Returns the inspect calls so a test can count them. */
function stubGoogle(answers: Record<string, Answer>) {
	const inspected: string[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/sites')) {
				return Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
			}
			if (url.includes('searchAnalytics')) return Response.json({})
			const { inspectionUrl, siteUrl } = JSON.parse(String(init?.body)) as {
				inspectionUrl: string
				siteUrl: string
			}
			inspected.push(inspectionUrl)
			expect(siteUrl).toBe(SITE)
			const answer = answers[inspectionUrl]
			if (!answer || 'status' in answer) {
				return new Response('bad request', {
					status: (answer as { status: number })?.status ?? 400,
				})
			}
			return Response.json({ inspectionResult: { indexStatusResult: answer } })
		}),
	)
	return inspected
}

async function setup() {
	const ws = await insertWorkspace(db, getTestActorId())
	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: GSC_PROVIDER,
			status: 'active',
			externalId: 'gsc-index-test',
			credentials: 'unused: the access token is injected',
			// Already synced for the day, so syncAllGscIntegrations makes no sync calls.
			config: { gsc: { lastSyncedDate: '2026-10-10', backfilledAt: '2026-10-01T00:00:00Z' } },
			createdBy: getTestActorId(),
		})
		.returning()
	// The daily sync's rows object for the property.
	const dailyRow: GscRow = ['2026-10-09', HOME, 'maskin', 'usa', 'DESKTOP', 40, 4, 0.1, 5]
	const propertyObject = await insertObject(db, ws.id, getTestActorId(), {
		type: 'knowledge',
		title: `Google Search Console: ${SITE}`,
		content: serializeRows([dailyRow]),
		metadata: {
			provider: GSC_PROVIDER,
			external_id: SITE,
			integration_id: integration.id,
			last_synced_date: '2026-10-10',
		},
	})
	const piece = (url: string | null, extra: Record<string, unknown> = {}) =>
		insertObject(db, ws.id, getTestActorId(), {
			type: 'content',
			status: 'live',
			metadata: { ...(url ? { canonical_url: url } : {}), ...extra },
		})
	return { ws, integration, propertyObject, piece }
}

const deps = (now: Date) => ({ now, sleep: async () => {}, getAccessToken: async () => 'tok' })
// The sync entry points take the clock as a function; inspectIndexStatus takes the date.
const syncDeps = (now: Date) => ({ ...deps(now), now: () => now })

async function indexObjects(workspaceId: string) {
	return db
		.select()
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				sql`${objects.metadata}->>'provider' = ${GSC_INDEX_PROVIDER}`,
			),
		)
}

async function metadataOf(id: string) {
	const [found] = await db
		.select({ metadata: objects.metadata })
		.from(objects)
		.where(eq(objects.id, id))
	return found?.metadata as Record<string, unknown>
}

async function eventsFor(workspaceId: string, entityId: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityId, entityId)))
		.orderBy(asc(events.id))
}

describe('Search Console index status against real Postgres', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('saves one index object per property and writes the state onto live content', async () => {
		const { ws, integration, piece } = await setup()
		const home = await piece(HOME, { rank_band: 'top_10', gsc_index_request: 'pending_manual' })
		const unknown = await piece(UNKNOWN)
		const elsewhere = await piece(ELSEWHERE)
		const broken = await piece(BROKEN)
		const outside = await piece(OUTSIDE)
		const linkedin = await piece(null)
		const inspected = stubGoogle(defaultAnswers())

		const summary = await inspectIndexStatus(db, integration, deps(DAY1))

		expect(summary).toEqual({
			inspected: 4,
			errors: 1,
			noProperty: 1,
			properties: 1,
			quotaStopped: 0,
			failed: 0,
		})
		expect(inspected.sort()).toEqual([BROKEN, ELSEWHERE, HOME, UNKNOWN].sort())

		const [index, ...rest] = await indexObjects(ws.id)
		expect(rest).toHaveLength(0)
		expect(index.title).toBe(`Google Search Console index status: ${SITE}`)
		expect(index.type).toBe('knowledge')
		expect(index.metadata).toMatchObject({
			provider: 'google-search-console-index',
			external_id: SITE,
			property_url: SITE,
			integration_id: integration.id,
			last_inspected_date: '2026-10-12',
			urls_tracked: 4,
			urls_inspected_last_run: 4,
			indexed_count: 1,
			canonical_elsewhere_count: 1,
			not_indexed_count: 1,
			unknown_count: 1,
			error_count: 1,
		})
		// One page of four failing is not a failed property.
		expect(index.metadata).not.toHaveProperty('last_error')
		expect(index.metadata).not.toHaveProperty('first_failure_at')
		expect(index.metadata).not.toHaveProperty('quota_stopped_at')
		for (const value of Object.values(index.metadata as object)) {
			expect(['string', 'number', 'boolean']).toContain(typeof value)
		}
		const rows = new Map(parseIndexRows(index.content).map((r) => [r.url, r]))
		expect([...rows.keys()].sort()).toEqual([BROKEN, ELSEWHERE, HOME, UNKNOWN].sort())
		expect(rows.get(HOME)).toMatchObject({
			source: 'tracked',
			state: 'indexed',
			verdict: 'PASS',
			coverageState: 'Submitted and indexed',
			state_since: '2026-10-12',
			error: null,
		})
		expect(rows.get(UNKNOWN)).toMatchObject({
			state: 'not_indexed',
			verdict: 'NEUTRAL',
			coverageState: 'URL is unknown to Google',
			lastCrawlTime: null,
			googleCanonical: null,
		})
		expect(rows.get(ELSEWHERE)?.state).toBe('canonical_elsewhere')
		expect(rows.get(BROKEN)).toMatchObject({
			state: 'unknown',
			error: expect.stringContaining('HTTP 400'),
		})

		// The writeback, merged next to what was already there.
		expect(await metadataOf(home.id)).toMatchObject({
			canonical_url: HOME,
			rank_band: 'top_10',
			gsc_index_request: 'pending_manual',
			gsc_index_state: 'indexed',
			gsc_coverage_state: 'Submitted and indexed',
			gsc_index_checked_at: '2026-10-12',
		})
		expect(await metadataOf(unknown.id)).toMatchObject({
			gsc_index_state: 'not_indexed',
			gsc_coverage_state: 'URL is unknown to Google',
		})
		expect(await metadataOf(elsewhere.id)).toMatchObject({ gsc_index_state: 'canonical_elsewhere' })
		expect(await metadataOf(broken.id)).toMatchObject({
			gsc_index_state: 'unknown',
			gsc_coverage_state: '',
		})
		// No property covers it, and a piece with no canonical_url is never tracked.
		expect(await metadataOf(outside.id)).not.toHaveProperty('gsc_index_state')
		expect(await metadataOf(linkedin.id)).not.toHaveProperty('gsc_index_state')
		// Not ours to write.
		expect(await metadataOf(unknown.id)).not.toHaveProperty('rank_band')
		expect(await metadataOf(home.id)).toMatchObject({ rank_band: 'top_10' })

		// One audit event per changed piece, naming only the changed fields.
		const audit = await eventsFor(ws.id, home.id)
		expect(audit).toHaveLength(1)
		expect(audit[0]?.data).toMatchObject({
			source: 'google-search-console-sync',
			fields: ['gsc_index_state', 'gsc_coverage_state', 'gsc_index_checked_at'],
			old: { gsc_index_state: null },
			new: { gsc_index_state: 'indexed', gsc_index_checked_at: '2026-10-12' },
		})
		expect(await eventsFor(ws.id, outside.id)).toHaveLength(0)
	})

	it('makes zero Google calls on a second tick the same date, and writes nothing again', async () => {
		const { ws, integration, piece } = await setup()
		const home = await piece(HOME)
		stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY1))
		const [before] = await indexObjects(ws.id)
		const eventsBefore = await eventsFor(ws.id, home.id)

		const inspected = stubGoogle(defaultAnswers())
		const getAccessToken = vi.fn(async () => 'tok')
		const summary = await inspectIndexStatus(db, integration, {
			...deps(DAY1_LATE),
			getAccessToken,
		})

		expect(inspected).toEqual([])
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(summary).toMatchObject({ inspected: 0 })
		const [after] = await indexObjects(ws.id)
		expect(after.content).toBe(before.content)
		expect(after.metadata).toEqual(before.metadata)
		expect(await eventsFor(ws.id, home.id)).toHaveLength(eventsBefore.length)
	})

	it('inspects again on the next calendar date, even less than 24 hours later', async () => {
		const { ws, integration, piece } = await setup()
		const home = await piece(HOME)
		stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY1))

		const inspected = stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY2))

		expect(inspected).toEqual([HOME])
		const [index] = await indexObjects(ws.id)
		expect(index.metadata).toMatchObject({ last_inspected_date: '2026-10-13' })
		// Same state: state_since stays, only the check date moves.
		expect(parseIndexRows(index.content)[0]).toMatchObject({
			state: 'indexed',
			state_since: '2026-10-12',
			checked_at: '2026-10-13T09:00:00.000Z',
		})
		expect(await metadataOf(home.id)).toMatchObject({
			gsc_index_state: 'indexed',
			gsc_index_checked_at: '2026-10-13',
		})
		const audit = await eventsFor(ws.id, home.id)
		expect(audit).toHaveLength(2)
		expect(audit[1]?.data).toMatchObject({ fields: ['gsc_index_checked_at'] })
	})

	it('records a state change: state_since moves and the event carries the old and new state', async () => {
		const { ws, integration, piece } = await setup()
		const home = await piece(HOME)
		stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY1))

		stubGoogle({ ...defaultAnswers(), [HOME]: UNKNOWN_TO_GOOGLE })
		await inspectIndexStatus(db, integration, deps(DAY2))

		const [index] = await indexObjects(ws.id)
		expect(parseIndexRows(index.content)[0]).toMatchObject({
			state: 'not_indexed',
			state_since: '2026-10-13',
			coverageState: 'URL is unknown to Google',
		})
		const audit = await eventsFor(ws.id, home.id)
		expect(audit.at(-1)?.data).toMatchObject({
			source: 'google-search-console-sync',
			fields: ['gsc_index_state', 'gsc_coverage_state', 'gsc_index_checked_at'],
			old: { gsc_index_state: 'indexed', gsc_coverage_state: 'Submitted and indexed' },
			new: { gsc_index_state: 'not_indexed', gsc_coverage_state: 'URL is unknown to Google' },
		})
	})

	it('inspects only properties that contain a tracked page', async () => {
		const { ws, integration, piece } = await setup()
		await piece(HOME)
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Google Search Console: sc-domain:big.test',
			content: serializeRows([]),
			metadata: {
				provider: GSC_PROVIDER,
				external_id: 'sc-domain:big.test',
				integration_id: integration.id,
			},
		})
		const inspected = stubGoogle(defaultAnswers())

		await inspectIndexStatus(db, integration, deps(DAY1))

		// The big property has no tracked page: no call, no index object.
		expect(inspected).toEqual([HOME])
		const saved = await indexObjects(ws.id)
		expect(saved.map((o) => (o.metadata as { external_id: string }).external_id)).toEqual([SITE])
	})

	it('skips a page that stopped being live and drops its row on the next inspection', async () => {
		const { ws, integration, piece } = await setup()
		await piece(HOME)
		const gone = await piece(UNKNOWN)
		stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY1))

		await db.update(objects).set({ status: 'archived' }).where(eq(objects.id, gone.id))
		stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY2))

		const [index] = await indexObjects(ws.id)
		expect(parseIndexRows(index.content).map((r) => r.url)).toEqual([HOME])
	})

	it('is skipped entirely when the token cannot be fetched', async () => {
		const { ws, integration, piece } = await setup()
		await piece(HOME)
		const inspected = stubGoogle(defaultAnswers())
		await expect(
			inspectIndexStatus(db, integration, {
				...deps(DAY1),
				getAccessToken: async () => {
					throw new Error('invalid_grant')
				},
			}),
		).rejects.toThrow('invalid_grant')
		expect(inspected).toEqual([])
		expect(await indexObjects(ws.id)).toHaveLength(0)
	})
})

describe('the daily sync and the index object leave each other alone', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('keeps both objects intact across an inspection and the next daily sync', async () => {
		const { ws, integration, propertyObject, piece } = await setup()
		const home = await piece(HOME, { primary_keyword: 'maskin' })
		stubGoogle(defaultAnswers())

		// Hook path: sync (already current, no calls) then inspection.
		await syncAllGscIntegrations(db, syncDeps(DAY1))
		const [index] = await indexObjects(ws.id)
		expect(parseIndexRows(index.content)).toHaveLength(1)

		// A daily sync lookup by provider still sees exactly one row for the property.
		const lookup = () =>
			db
				.select({ id: objects.id })
				.from(objects)
				.where(
					and(
						eq(objects.workspaceId, ws.id),
						eq(objects.type, 'knowledge'),
						sql`${objects.metadata}->>'provider' = ${GSC_PROVIDER}`,
						sql`${objects.metadata}->>'external_id' = ${SITE}`,
					),
				)
		expect((await lookup()).map((r) => r.id)).toEqual([propertyObject.id])

		// The next day's daily sync rewrites the rows object, not the index object.
		const [rowsBefore] = await db.select().from(objects).where(eq(objects.id, propertyObject.id))
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		stubGoogle(defaultAnswers())
		await syncGscIntegration(db, row, syncDeps(DAY2))

		const [rowsAfter] = await db.select().from(objects).where(eq(objects.id, propertyObject.id))
		expect(rowsBefore.metadata).not.toHaveProperty('read_status')
		expect(rowsAfter.metadata).toMatchObject({
			provider: GSC_PROVIDER,
			external_id: SITE,
			read_status: 'ok',
		})
		expect(parseRows(rowsAfter.content)).toEqual(parseRows(rowsBefore.content))
		expect((await lookup()).map((r) => r.id)).toEqual([propertyObject.id])
		// The sync neither wrote into nor wiped the index object.
		const [indexAfter] = await indexObjects(ws.id)
		expect(indexAfter.id).toBe(index.id)
		expect(indexAfter.content).toBe(index.content)
		expect(indexAfter.metadata).toEqual(index.metadata)
		expect(home.id).toBeDefined()
	})

	it('leaves search_demand as the rows object alone derives it', async () => {
		const { ws, integration, piece } = await setup()
		// 40 impressions at position 5 on the home page, multiplier 1.
		const home = await piece(HOME, { primary_keyword: 'maskin' })
		const derive = async () => {
			await db
				.update(objects)
				.set({ metadata: sql`${objects.metadata} - 'search_demand' - 'search_demand_source'` })
				.where(eq(objects.id, home.id))
			return writeSearchDemand(db, {
				workspaceId: ws.id,
				actorId: getTestActorId(),
				now: DAY1,
			})
		}
		const withoutIndex = await derive()
		const valueWithout = (await metadataOf(home.id)).search_demand

		stubGoogle(defaultAnswers())
		await inspectIndexStatus(db, integration, deps(DAY1))
		expect(await indexObjects(ws.id)).toHaveLength(1)
		const withIndex = await derive()

		expect(withIndex).toEqual(withoutIndex)
		expect((await metadataOf(home.id)).search_demand).toBe(valueWithout)
		expect(valueWithout).toBe(40)
	})
})

// ── Seen-only pages, the daily cap and Google errors ───────────────────────────────────

const SECOND = 'sc-domain:second.test'
const SECOND_HOME = 'https://second.test/'
const OK = { verdict: 'PASS', coverageState: 'Submitted and indexed' }

type SiteAnswer = (siteUrl: string, url: string, nth: number) => Answer | undefined

/** Stubs Google for several properties. nth counts fetches for that property, retries included. */
function stubGoogleBySite(answer: SiteAnswer) {
	const calls: { siteUrl: string; url: string }[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/sites')) return Response.json({ siteEntry: [] })
			if (url.includes('searchAnalytics')) return Response.json({})
			const body = JSON.parse(String(init?.body)) as { inspectionUrl: string; siteUrl: string }
			calls.push({ siteUrl: body.siteUrl, url: body.inspectionUrl })
			const nth = calls.filter((c) => c.siteUrl === body.siteUrl).length
			const found = answer(body.siteUrl, body.inspectionUrl, nth) ?? OK
			if ('status' in found) return new Response('error', { status: found.status as number })
			return Response.json({ inspectionResult: { indexStatusResult: found } })
		}),
	)
	return calls
}

/** The inspected URLs after the first (tracked) one, sorted. */
const seenCalls = (calls: { url: string }[]) =>
	calls
		.slice(1)
		.map((c) => c.url)
		.sort()

const syncRow = (page: string, date = '2026-10-09'): GscRow => [
	date,
	page,
	'maskin',
	'usa',
	'DESKTOP',
	5,
	1,
	0.2,
	7,
]

const setSyncRows = (id: string, rows: GscRow[]) =>
	db
		.update(objects)
		.set({ content: serializeRows(rows) })
		.where(eq(objects.id, id))

async function addProperty(workspaceId: string, integrationId: string, siteUrl: string) {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'knowledge',
		title: `Google Search Console: ${siteUrl}`,
		content: serializeRows([]),
		metadata: { provider: GSC_PROVIDER, external_id: siteUrl, integration_id: integrationId },
	})
}

async function indexFor(workspaceId: string, siteUrl: string) {
	const found = await indexObjects(workspaceId)
	const index = found.find((o) => (o.metadata as { external_id: string }).external_id === siteUrl)
	if (!index) throw new Error(`no index object for ${siteUrl}`)
	const meta = index.metadata as Record<string, unknown>
	return { ...index, rows: parseIndexRows(index.content), meta }
}

describe('seen-only pages and the daily cap', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('inspects seen-only pages after the tracked ones, each row marked with its source', async () => {
		const { ws, integration, propertyObject, piece } = await setup()
		await piece(HOME)
		const seenA = 'https://gsc-index.test/seen-a'
		const seenB = 'https://www.gsc-index.test/seen-b'
		await setSyncRows(propertyObject.id, [
			syncRow(HOME),
			syncRow(seenA),
			syncRow(seenB),
			// Not under any connected property, and too old for the 30 day window.
			syncRow('https://other.example/seen'),
			syncRow('https://gsc-index.test/old-seen', '2026-08-01'),
		])
		const calls = stubGoogleBySite(() => undefined)

		const summary = await inspectIndexStatus(db, integration, deps(DAY1))

		expect(summary).toMatchObject({ inspected: 3, errors: 0, properties: 1 })
		expect(calls[0]?.url).toBe(HOME)
		expect(seenCalls(calls)).toEqual([seenA, seenB])
		const index = await indexFor(ws.id, SITE)
		expect(new Map(index.rows.map((r) => [r.url, r.source]))).toEqual(
			new Map([
				[HOME, 'tracked'],
				[seenA, 'seen'],
				[seenB, 'seen'],
			]),
		)
		// The counts in metadata match the content.
		expect(index.meta).toMatchObject({
			urls_tracked: 1,
			urls_inspected_last_run: 3,
			indexed_count: 3,
			not_indexed_count: 0,
			unknown_count: 0,
			error_count: 0,
			last_inspected_date: '2026-10-12',
		})
	})

	it('keeps seen-only pages to a 7 date cadence, oldest first, and tracked pages daily', async () => {
		const { ws, integration, propertyObject, piece } = await setup()
		await piece(HOME)
		const seenA = 'https://gsc-index.test/seen-a'
		const seenB = 'https://gsc-index.test/seen-b'
		await setSyncRows(propertyObject.id, [syncRow(seenA), syncRow(seenB)])
		stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY1))

		// Same date: nothing is due.
		let calls = stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY1_LATE))
		expect(calls).toEqual([])

		// Next date: only the tracked page.
		calls = stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY2))
		expect(calls.map((c) => c.url)).toEqual([HOME])

		// 7 dates after the seen-only pages were checked: all three are due, tracked first.
		calls = stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY8))
		expect(calls[0]?.url).toBe(HOME)
		expect(seenCalls(calls)).toEqual([seenA, seenB])
		const index = await indexFor(ws.id, SITE)
		expect(index.rows).toHaveLength(3)
	})

	it('never makes more than 300 calls for a property on one date, tracked page first', async () => {
		const { ws, integration, propertyObject, piece } = await setup()
		await piece(HOME)
		const pages = Array.from({ length: 310 }, (_, i) => `https://gsc-index.test/seen/${i}`)
		await setSyncRows(
			propertyObject.id,
			pages.map((page) => syncRow(page)),
		)

		let calls = stubGoogleBySite(() => undefined)
		const first = await inspectIndexStatus(db, integration, deps(DAY1))
		expect(calls).toHaveLength(300)
		expect(calls[0]?.url).toBe(HOME)
		expect(first).toMatchObject({ inspected: 300 })

		// A later tick the same date has no budget left.
		calls = stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY1_LATE))
		expect(calls).toEqual([])

		// The next date: the tracked page again, plus the 11 seen-only pages still never checked.
		calls = stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY2))
		expect(calls).toHaveLength(12)
		expect(calls[0]?.url).toBe(HOME)
		const index = await indexFor(ws.id, SITE)
		expect(index.rows).toHaveLength(311)
		expect(index.meta).toMatchObject({ urls_tracked: 1, urls_inspected_last_run: 12 })
	})

	it('drops seen-only rows first past 5,000 rows and says so in last_error', async () => {
		const { ws, integration, propertyObject, piece } = await setup()
		await piece(HOME)
		const pages = Array.from({ length: 5001 }, (_, i) => `https://gsc-index.test/seen/${i}`)
		await setSyncRows(
			propertyObject.id,
			pages.map((page) => syncRow(page)),
		)
		const stored = (url: string): IndexRow => ({
			url,
			source: 'seen',
			checked_at: '2026-09-01T00:00:00.000Z',
			state: 'indexed',
			verdict: 'PASS',
			coverageState: 'Submitted and indexed',
			lastCrawlTime: null,
			robotsTxtState: null,
			indexingState: null,
			pageFetchState: null,
			googleCanonical: null,
			userCanonical: null,
			state_since: '2026-09-01',
			error: null,
		})
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: `Google Search Console index status: ${SITE}`,
			content: serializeIndexRows(pages.map(stored)),
			metadata: {
				provider: GSC_INDEX_PROVIDER,
				external_id: SITE,
				property_url: SITE,
				integration_id: integration.id,
			},
		})
		stubGoogleBySite(() => undefined)

		await inspectIndexStatus(db, integration, deps(DAY1))

		const index = await indexFor(ws.id, SITE)
		expect(index.rows).toHaveLength(5000)
		// The tracked page is kept; the seen-only pages that did not fit are gone.
		expect(index.rows.find((r) => r.url === HOME)?.source).toBe('tracked')
		expect(index.rows.some((r) => r.url === pages[5000])).toBe(false)
		expect(index.meta.last_error).toBe('Over the 5000 row limit: dropped 2 pages, seen-only first')
		expect(index.meta).not.toHaveProperty('first_failure_at')
	})
})

describe('quota and Google errors', () => {
	afterEach(() => vi.unstubAllGlobals())

	async function twoProperties() {
		const base = await setup()
		await addProperty(base.ws.id, base.integration.id, SECOND)
		const piece = base.piece
		const tracked = [HOME, 'https://gsc-index.test/t2', 'https://gsc-index.test/t3']
		for (const url of tracked) await piece(url)
		await piece(SECOND_HOME)
		return { ...base, tracked }
	}

	it('stops a property on a 429 that outlasts the retries, keeps its rows, and runs the others', async () => {
		const { ws, integration, tracked } = await twoProperties()
		// Day 1: everything is inspected.
		stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY1))

		// Day 2: the first call for SITE works, every call after it is a 429.
		let calls = stubGoogleBySite((siteUrl, _url, nth) =>
			siteUrl === SITE && nth > 1 ? { status: 429 } : undefined,
		)
		const summary = await inspectIndexStatus(db, integration, deps(DAY2))

		const index = await indexFor(ws.id, SITE)
		expect(summary).toMatchObject({ quotaStopped: 1, failed: 0 })
		// One page inspected, then three tries on the next one, then the property stops.
		expect(calls.filter((c) => c.siteUrl === SITE)).toHaveLength(4)
		expect(index.meta.quota_stopped_at).toBe(DAY2.toISOString())
		expect(index.meta).toMatchObject({ urls_inspected_last_run: 1, urls_tracked: 3 })
		// Rows already saved remain: all three, one of them refreshed today.
		expect(index.rows).toHaveLength(3)
		const refreshed = index.rows.filter((r) => r.checked_at.startsWith('2026-10-13'))
		expect(refreshed).toHaveLength(1)
		// The other property ran in full and carries no stop.
		const second = await indexFor(ws.id, SECOND)
		expect(second.rows.find((r) => r.url === SECOND_HOME)?.checked_at).toBe(DAY2.toISOString())
		expect(second.meta).not.toHaveProperty('quota_stopped_at')

		// The next tick resumes with the pages checked on day 1, not the one done today.
		calls = stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY2_LATE))
		const resumed = calls.filter((c) => c.siteUrl === SITE).map((c) => c.url)
		expect(resumed).toHaveLength(2)
		expect(resumed).not.toContain(refreshed[0]?.url)
		expect([...resumed, refreshed[0]?.url].sort()).toEqual([...tracked].sort())
		// A clean run clears the stop.
		expect((await indexFor(ws.id, SITE)).meta).not.toHaveProperty('quota_stopped_at')
	})

	it('skips a property on a 403, keeps first_failure_at while it lasts, and clears it on a clean run', async () => {
		const { ws, integration } = await twoProperties()
		const forbidden: SiteAnswer = (siteUrl) => (siteUrl === SECOND ? { status: 403 } : undefined)

		stubGoogleBySite(forbidden)
		const summary = await inspectIndexStatus(db, integration, deps(DAY1))
		expect(summary).toMatchObject({ failed: 1, quotaStopped: 0 })
		// The other property was inspected as usual.
		const index = await indexFor(ws.id, SITE)
		expect(index.rows).toHaveLength(3)
		expect(index.meta).not.toHaveProperty('last_error')
		const failing = await indexFor(ws.id, SECOND)
		expect(failing.meta.last_error).toEqual(expect.stringContaining('HTTP 403'))
		expect(failing.meta.first_failure_at).toBe(DAY1.toISOString())
		expect(failing.rows).toEqual([])

		// Still forbidden the next date: the streak keeps its first time.
		stubGoogleBySite(forbidden)
		await inspectIndexStatus(db, integration, deps(DAY2))
		const still = await indexFor(ws.id, SECOND)
		expect(still.meta.first_failure_at).toBe(DAY1.toISOString())
		expect(still.meta.last_error).toEqual(expect.stringContaining('HTTP 403'))

		// A clean run clears both.
		stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY3))
		const cleared = await indexFor(ws.id, SECOND)
		expect(cleared.meta).not.toHaveProperty('last_error')
		expect(cleared.meta).not.toHaveProperty('first_failure_at')
		expect(cleared.rows.map((r) => r.url)).toEqual([SECOND_HOME])

		// The integration itself was never touched.
		const [stored] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		expect(stored.status).toBe('active')
		expect(stored.config).toEqual({
			gsc: { lastSyncedDate: '2026-10-10', backfilledAt: '2026-10-01T00:00:00Z' },
		})
	})

	it('gives a page a 400 or a 5xx an unknown state and an error, and the run goes on', async () => {
		const { ws, integration, piece } = await setup()
		await piece(HOME)
		await piece(BROKEN)
		const down = 'https://gsc-index.test/down'
		await piece(down)
		const calls = stubGoogleBySite((_site, url) =>
			url === BROKEN ? { status: 400 } : url === down ? { status: 503 } : undefined,
		)

		const summary = await inspectIndexStatus(db, integration, deps(DAY1))

		expect(summary).toMatchObject({ inspected: 3, errors: 2, failed: 0, quotaStopped: 0 })
		// The 503 is tried three times before it counts as that page's error.
		expect(calls.filter((c) => c.url === down)).toHaveLength(3)
		const index = await indexFor(ws.id, SITE)
		const byUrl = new Map(index.rows.map((r) => [r.url, r]))
		expect(byUrl.get(BROKEN)).toMatchObject({
			state: 'unknown',
			error: expect.stringContaining('HTTP 400'),
		})
		expect(byUrl.get(down)).toMatchObject({
			state: 'unknown',
			error: expect.stringContaining('HTTP 503'),
		})
		expect(byUrl.get(HOME)).toMatchObject({ state: 'indexed', error: null })
		expect(index.meta).toMatchObject({ error_count: 2, unknown_count: 2, indexed_count: 1 })
		expect(index.meta).not.toHaveProperty('last_error')
	})

	it('marks a property failed only when every inspected page errored', async () => {
		const { ws, integration, piece } = await setup()
		await piece(BROKEN)
		await piece('https://gsc-index.test/broken-2')
		stubGoogleBySite(() => ({ status: 400 }))

		const summary = await inspectIndexStatus(db, integration, deps(DAY1))

		// The two tracked pages, and the home page the sync saw.
		expect(summary).toMatchObject({ inspected: 3, errors: 3, failed: 1 })
		const index = await indexFor(ws.id, SITE)
		expect(index.rows.every((r) => r.state === 'unknown' && r.error !== null)).toBe(true)
		expect(index.meta.last_error).toEqual(
			expect.stringContaining('Every inspection in this run failed'),
		)
		expect(index.meta.first_failure_at).toBe(DAY1.toISOString())
		expect(index.meta.error_count).toBe(3)

		// The next date every page works: the failure clears.
		stubGoogleBySite(() => undefined)
		await inspectIndexStatus(db, integration, deps(DAY2))
		const after = await indexFor(ws.id, SITE)
		expect(after.meta).not.toHaveProperty('last_error')
		expect(after.meta).not.toHaveProperty('first_failure_at')
	})
})
