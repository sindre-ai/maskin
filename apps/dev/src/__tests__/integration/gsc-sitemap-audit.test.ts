import { events, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	SITEMAP_DELETED,
	SITEMAP_SUBMITTED,
	lastSitemapAction,
	recordSitemapAction,
} from '../../lib/integrations/providers/google-search-console/sitemaps'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const PROPERTY = 'sc-domain:sitemap-audit.test'
const SITEMAP = 'https://sitemap-audit.test/sitemap.xml'

async function insertConnection(workspaceId: string, status: 'active' | 'revoked' = 'active') {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-search-console',
			status,
			externalId: `sitemap-audit-${crypto.randomUUID()}`,
			credentials: 'unused',
			config: {},
			createdBy: getTestActorId(),
		})
		.returning()
	return row
}

function record(
	workspaceId: string,
	integrationId: string,
	action: typeof SITEMAP_SUBMITTED | typeof SITEMAP_DELETED,
	overrides: { property?: string; sitemapUrl?: string } = {},
) {
	return recordSitemapAction(db, action, {
		workspaceId,
		actorId: getTestActorId(),
		integrationId,
		property: overrides.property ?? PROPERTY,
		sitemapUrl: overrides.sitemapUrl ?? SITEMAP,
	})
}

const lookup = (workspaceId: string, overrides: { property?: string; sitemapUrl?: string } = {}) =>
	lastSitemapAction(db, {
		workspaceId,
		property: overrides.property ?? PROPERTY,
		sitemapUrl: overrides.sitemapUrl ?? SITEMAP,
	})

describe('Search Console sitemap audit trail', () => {
	it('finds nothing for a sitemap Maskin never submitted', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const conn = await insertConnection(ws.id)
		await record(ws.id, conn.id, SITEMAP_SUBMITTED, {
			sitemapUrl: 'https://sitemap-audit.test/other.xml',
		})

		expect(await lookup(ws.id)).toBeNull()
	})

	it('returns the newest of a submit and a later delete', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const conn = await insertConnection(ws.id)

		await record(ws.id, conn.id, SITEMAP_SUBMITTED)
		expect(await lookup(ws.id)).toBe(SITEMAP_SUBMITTED)

		await record(ws.id, conn.id, SITEMAP_DELETED)
		expect(await lookup(ws.id)).toBe(SITEMAP_DELETED)

		await record(ws.id, conn.id, SITEMAP_SUBMITTED)
		expect(await lookup(ws.id)).toBe(SITEMAP_SUBMITTED)
	})

	it('still finds the submit after a reconnect gave the workspace a new connection', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const before = await insertConnection(ws.id)
		await record(ws.id, before.id, SITEMAP_SUBMITTED)

		// Reconnect: the old row is revoked and a new one takes over.
		await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, before.id))
		await insertConnection(ws.id)

		expect(await lookup(ws.id)).toBe(SITEMAP_SUBMITTED)
	})

	it('keys on the exact property and sitemap URL', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const conn = await insertConnection(ws.id)
		await record(ws.id, conn.id, SITEMAP_SUBMITTED)

		expect(await lookup(ws.id, { property: 'sc-domain:other.test' })).toBeNull()
		expect(
			await lookup(ws.id, { sitemapUrl: 'https://sitemap-audit.test/sitemap2.xml' }),
		).toBeNull()
	})

	it('does not see another workspace submit', async () => {
		const mine = await insertWorkspace(db, getTestActorId())
		const theirs = await insertWorkspace(db, getTestActorId())
		const theirConn = await insertConnection(theirs.id)
		await record(theirs.id, theirConn.id, SITEMAP_SUBMITTED)

		expect(await lookup(mine.id)).toBeNull()
	})

	it('writes the row the lookup reads, attributed to the calling actor', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const conn = await insertConnection(ws.id)

		await record(ws.id, conn.id, SITEMAP_SUBMITTED)

		const rows = await db.select().from(events).where(eq(events.entityId, conn.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			workspaceId: ws.id,
			actorId: getTestActorId(),
			action: SITEMAP_SUBMITTED,
			entityType: 'integration',
			data: { provider: 'google-search-console', property: PROPERTY, sitemap_url: SITEMAP },
		})
	})
})
