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

function stubSearchConsole(rowsByDimension: Record<string, Array<[string, string]>>) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith('/sites')) {
				return Response.json({ siteEntry: [{ siteUrl: SITE, permissionLevel: 'siteOwner' }] })
			}
			const body = JSON.parse(String(init?.body)) as {
				startDate: string
				dimensions: string[]
			}
			const wanted = rowsByDimension[body.dimensions[1]] ?? []
			return Response.json({
				rows: wanted
					.filter(([date]) => date >= body.startDate)
					.map(([date, key]) => ({
						keys: [date, key],
						clicks: 2,
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
		stubSearchConsole({
			page: [['2026-10-09', '/pricing']],
			query: [['2026-10-09', 'maskin pricing']],
		})

		const day1 = { now: () => new Date('2026-10-11T10:00:00Z'), getAccessToken: async () => 't' }
		await syncGscIntegration(db, integration, day1)

		let [property, ...rest] = await propertyObjects(ws.id)
		expect(rest).toHaveLength(0)
		expect(property.title).toBe(`Google Search Console: ${SITE}`)
		expect(property.metadata).toMatchObject({
			provider: 'google-search-console',
			external_id: SITE,
			last_synced_date: '2026-10-09',
			url_row_count: 1,
			query_row_count: 1,
		})
		expect(parseRows(property.content)).toHaveLength(2)

		// Next day: Search Console now has the following date as well.
		stubSearchConsole({
			page: [
				['2026-10-09', '/pricing'],
				['2026-10-10', '/pricing'],
			],
			query: [['2026-10-10', 'maskin pricing']],
		})
		const [fresh] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		const day2 = { now: () => new Date('2026-10-12T10:00:00Z'), getAccessToken: async () => 't' }
		await syncGscIntegration(db, fresh, day2)
		;[property, ...rest] = await propertyObjects(ws.id)
		expect(rest).toHaveLength(0)
		expect(property.metadata).toMatchObject({ last_synced_date: '2026-10-10' })
		const keys = parseRows(property.content).map((r) => `${r[1]}|${r[0]}|${r[2]}`)
		expect(new Set(keys).size).toBe(keys.length)
		expect(keys).toHaveLength(4)

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityId, property.id)))
		expect(audit.map((e) => e.action).sort()).toEqual(['created', 'updated'])
	})

	it('keeps retrying and flips the integration to error after 24 hours of failures', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const integration = await insertGscIntegration(ws.id)
		vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
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

		// Search Console recovers: the next run clears the streak and re-activates.
		stubSearchConsole({ page: [['2026-10-12', '/']], query: [['2026-10-12', 'maskin']] })
		await syncGscIntegration(db, row, deps('2026-10-14T10:00:00Z'))
		;[row] = await db.select().from(integrations).where(eq(integrations.id, integration.id))
		expect(row.status).toBe('active')
		expect((row.config as { gsc: { firstFailureAt?: string } }).gsc.firstFailureAt).toBeUndefined()
	})
})
