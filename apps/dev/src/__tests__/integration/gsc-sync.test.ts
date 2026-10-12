import { events, integrations, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	parseRows,
	syncGscIntegration,
} from '../../lib/integrations/providers/google-search-console/sync'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const SITE = 'sc-domain:gsc-sync.test'

type SourceRow = { keys: [string, string, string, string, string]; clicks?: number }

function stubSearchConsole(sourceRows: SourceRow[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/sites')) {
				return Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
			}
			const body = JSON.parse(String(init?.body)) as { startDate: string }
			return Response.json({
				rows: sourceRows
					.filter(({ keys }) => keys[0] >= body.startDate)
					.map(({ keys, clicks = 2 }) => ({
						keys,
						clicks,
						impressions: 20,
						ctr: 0.1,
						position: 4.5,
					})),
			})
		}),
	)
}

async function insertGscIntegration(workspaceId: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-search-console',
			status: 'active',
			externalId: 'gsc-sync-test',
			credentials: 'unused: the access token is injected',
			config: {},
			createdBy: getTestActorId(),
		})
		.returning()
	return row
}

async function reloadIntegration(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return row
}

async function propertyObjects(workspaceId: string) {
	return db
		.select()
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'knowledge')))
}

describe('Search Console sync against real Postgres', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('upserts one knowledge object per property and never duplicates rows on a repeat run', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const integration = await insertGscIntegration(ws.id)
		stubSearchConsole([{ keys: ['2026-10-09', '/pricing', 'maskin pricing', 'usa', 'DESKTOP'] }])

		const day1 = { now: () => new Date('2026-10-11T10:00:00Z'), getAccessToken: async () => 't' }
		await syncGscIntegration(db, integration, day1)

		let [property, ...rest] = await propertyObjects(ws.id)
		expect(rest).toHaveLength(0)
		expect(property.title).toBe(`Google Search Console: ${SITE}`)
		expect(property.metadata).toMatchObject({
			provider: 'google-search-console',
			external_id: SITE,
			last_synced_date: '2026-10-09',
			row_count: 1,
		})
		expect(parseRows(property.content)).toHaveLength(1)

		// Next day: Search Console now has the following date as well.
		stubSearchConsole([
			{ keys: ['2026-10-10', '/pricing', 'maskin pricing', 'usa', 'DESKTOP'] },
			{ keys: ['2026-10-10', '/pricing', 'maskin pricing', 'dnk', 'MOBILE'] },
		])
		const [fresh] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		const day2 = { now: () => new Date('2026-10-12T10:00:00Z'), getAccessToken: async () => 't' }
		await syncGscIntegration(db, fresh, day2)
		;[property, ...rest] = await propertyObjects(ws.id)
		expect(rest).toHaveLength(0)
		expect(property.metadata).toMatchObject({ last_synced_date: '2026-10-10', row_count: 3 })
		const keys = parseRows(property.content).map((r) => r.slice(0, 5).join('|'))
		expect(new Set(keys).size).toBe(keys.length)
		expect(keys).toHaveLength(3)

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityId, property.id)))
		expect(audit.map((e) => e.action).sort()).toEqual(['created', 'updated'])
	})

	it('keeps retrying and flips the integration to error after 24 hours of failures', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const integration = await insertGscIntegration(ws.id)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.endsWith('/sites')
					? Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
					: new Response('forbidden', { status: 403 }),
			),
		)
		const deps = (iso: string) => ({ now: () => new Date(iso), getAccessToken: async () => 't' })

		const firstRun = syncGscIntegration(db, integration, deps('2026-10-11T10:00:00Z'))
		await expect(firstRun).rejects.toThrow(/403/)
		let [row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		expect(row.status).toBe('active')
		expect((row.config as { gsc: { firstFailureAt: string } }).gsc.firstFailureAt).toBe(
			'2026-10-11T10:00:00.000Z',
		)

		const secondRun = syncGscIntegration(db, row, deps('2026-10-12T10:30:00Z'))
		await expect(secondRun).rejects.toThrow(/403/)
		;[row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		expect(row.status).toBe('error')

		// The property object carries the streak too, scalars only, from the first failure.
		let [property] = await propertyObjects(ws.id)
		expect(property.metadata).toMatchObject({
			external_id: SITE,
			row_count: 0,
			last_error: expect.stringContaining('HTTP 403'),
			first_failure_at: '2026-10-11T10:00:00.000Z',
		})

		// Search Console recovers: the next run clears the streak and re-activates.
		stubSearchConsole([{ keys: ['2026-10-12', '/', 'maskin', 'usa', 'DESKTOP'] }])
		await syncGscIntegration(db, row, deps('2026-10-14T10:00:00Z'))
		;[row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		expect(row.status).toBe('active')
		expect((row.config as { gsc: { firstFailureAt?: string } }).gsc.firstFailureAt).toBeUndefined()
		;[property] = await propertyObjects(ws.id)
		expect(property.metadata).not.toHaveProperty('last_error')
		expect(property.metadata).not.toHaveProperty('first_failure_at')
		expect(property.metadata).toMatchObject({ row_count: 1, last_synced_date: '2026-10-12' })
	})

	it('keeps rows and first_failure_at on a property that fails after a good sync', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const integration = await insertGscIntegration(ws.id)
		stubSearchConsole([{ keys: ['2026-10-09', '/pricing', 'maskin pricing', 'usa', 'DESKTOP'] }])
		const day1 = { now: () => new Date('2026-10-11T10:00:00Z'), getAccessToken: async () => 't' }
		await syncGscIntegration(db, integration, day1)

		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.endsWith('/sites')
					? Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
					: new Response('boom', { status: 403 }),
			),
		)
		const fail = (iso: string) => ({ now: () => new Date(iso), getAccessToken: async () => 't' })
		for (const iso of ['2026-10-12T10:00:00Z', '2026-10-12T16:00:00Z']) {
			const fresh = await reloadIntegration(integration.id)
			await expect(syncGscIntegration(db, fresh, fail(iso))).rejects.toThrow(/403/)
		}

		const [property, ...rest] = await propertyObjects(ws.id)
		expect(rest).toHaveLength(0)
		expect(property.metadata).toMatchObject({
			last_synced_date: '2026-10-09',
			row_count: 1,
			last_error: expect.stringContaining('HTTP 403'),
			// the first failure of the streak, not the latest
			first_failure_at: '2026-10-12T10:00:00.000Z',
		})
		expect(parseRows(property.content)).toHaveLength(1)
	})

	it('leaves stored rows intact when a property would pass the row cap, and syncs the other property', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const integration = await insertGscIntegration(ws.id)
		const OTHER = 'sc-domain:gsc-sync-other.test'
		const sitesResponse = () =>
			Response.json({
				siteEntry: [
					{ siteUrl: SITE, permissionLevel: 'siteOwner' },
					{ siteUrl: OTHER, permissionLevel: 'siteOwner' },
				],
			})
		const oneRow = (date: string) =>
			Response.json({
				rows: [
					{
						keys: [date, '/p', 'q', 'usa', 'DESKTOP'],
						clicks: 2,
						impressions: 20,
						ctr: 0.1,
						position: 4,
					},
				],
			})

		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				url.endsWith('/sites') ? sitesResponse() : oneRow('2026-10-09'),
			),
		)
		await syncGscIntegration(db, integration, {
			now: () => new Date('2026-10-11T10:00:00Z'),
			getAccessToken: async () => 't',
		})

		// Next day: SITE returns full pages of new rows forever, OTHER returns one new row.
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (url.endsWith('/sites')) return sitesResponse()
				if (!url.includes(encodeURIComponent(SITE))) return oneRow('2026-10-10')
				const { startRow } = JSON.parse(String(init?.body)) as { startRow: number }
				return Response.json({
					rows: Array.from({ length: 25_000 }, (_, i) => ({
						keys: ['2026-10-10', `/big${startRow + i}`, 'q', 'usa', 'DESKTOP'],
						clicks: 1,
						impressions: 10,
						ctr: 0.1,
						position: 4,
					})),
				})
			}),
		)
		const fresh = await reloadIntegration(integration.id)
		await expect(
			syncGscIntegration(db, fresh, {
				now: () => new Date('2026-10-12T10:00:00Z'),
				getAccessToken: async () => 't',
			}),
		).rejects.toThrow(/too large/)

		const properties = await propertyObjects(ws.id)
		const byProperty = (url: string) =>
			properties.find((p) => (p.metadata as { external_id: string }).external_id === url)
		const over = byProperty(SITE)
		const other = byProperty(OTHER)
		expect(over?.metadata).toMatchObject({
			last_error: 'too large',
			first_failure_at: '2026-10-12T10:00:00.000Z',
			// untouched by the failed run
			last_synced_date: '2026-10-09',
			row_count: 1,
		})
		expect(parseRows(over?.content ?? null)).toHaveLength(1)
		expect(other?.metadata).toMatchObject({ last_synced_date: '2026-10-10', row_count: 2 })
		expect(other?.metadata).not.toHaveProperty('last_error')
	})

	it('overwrites a stored row when the same key is fetched again', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const integration = await insertGscIntegration(ws.id)
		const keys: SourceRow['keys'] = ['2026-10-09', '/pricing', 'maskin pricing', 'usa', 'DESKTOP']
		stubSearchConsole([{ keys, clicks: 2 }])
		await syncGscIntegration(db, integration, {
			now: () => new Date('2026-10-11T10:00:00Z'),
			getAccessToken: async () => 't',
		})

		// Rewind the cursor so the next run re-fetches 2026-10-09 with corrected numbers.
		const [stored] = await propertyObjects(ws.id)
		await db
			.update(objects)
			.set({ metadata: { ...(stored.metadata as object), last_synced_date: '2026-10-08' } })
			.where(eq(objects.id, stored.id))
		stubSearchConsole([{ keys, clicks: 7 }])
		const fresh = await reloadIntegration(integration.id)
		await syncGscIntegration(
			db,
			{ ...fresh, config: {} },
			{ now: () => new Date('2026-10-11T12:00:00Z'), getAccessToken: async () => 't' },
		)

		const [property] = await propertyObjects(ws.id)
		const rows = parseRows(property.content)
		expect(rows).toHaveLength(1)
		expect(rows[0][6]).toBe(7)
	})
})
