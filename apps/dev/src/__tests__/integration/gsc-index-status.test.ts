import { events, integrations, objects } from '@maskin/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	GSC_INDEX_PROVIDER,
	inspectIndexStatus,
	parseIndexRows,
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

		expect(summary).toEqual({ inspected: 4, errors: 1, noProperty: 1, properties: 1 })
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
		await syncAllGscIntegrations(db, deps(DAY1))
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
		await syncGscIntegration(db, row, deps(DAY2))

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
