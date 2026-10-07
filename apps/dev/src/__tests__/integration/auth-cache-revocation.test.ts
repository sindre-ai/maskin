import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware, evictActor, evictMembership } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: workspacesRoutes } = await import('../../routes/workspaces')

/**
 * authMiddleware now caches the API-key and membership lookups. What that must
 * never do is keep honouring access that was just taken away by a route that
 * knows it revoked something, so these run against real rows with the cache ON
 * (60s TTL) and check each revoking path takes effect on the very next request.
 */

const TEST_API_KEY = 'ank_testintegration' // seeded in global-setup

type Env = {
	Variables: { db: Database; actorId: string; actorType: string }
}

function createApp() {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.use('*', authMiddleware(db, { cacheTtlMs: 60_000 }))
	app.get('/whoami', (c) => c.json({ actorId: c.get('actorId') }))
	app.route('/api/actors', actorsRoutes)
	app.route('/api/workspaces', workspacesRoutes)
	return app
}

const whoami = (app: ReturnType<typeof createApp>, key: string, workspaceId?: string) =>
	app.request(
		jsonGet('/whoami', {
			Authorization: `Bearer ${key}`,
			...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
		}),
	)

describe('auth cache revocation — real Postgres', () => {
	let workspaceId: string
	let victimId: string
	let victimKey: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id

		const victim = await insertActor(db, { type: 'agent' })
		if (!victim) throw new Error('failed to seed actor')
		victimId = victim.id
		victimKey = victim.apiKey as string
		await db.insert(workspaceMembers).values({ workspaceId, actorId: victimId, role: 'member' })
	})

	it('serves a repeated request from cache while nothing has been revoked', async () => {
		const app = createApp()
		expect((await whoami(app, victimKey, workspaceId)).status).toBe(200)

		// Remove the membership behind the cache's back: still honoured until evicted
		// or expired, which is the TTL trade-off the cache documents.
		await db
			.delete(workspaceMembers)
			.where(
				and(eq(workspaceMembers.actorId, victimId), eq(workspaceMembers.workspaceId, workspaceId)),
			)

		expect((await whoami(app, victimKey, workspaceId)).status).toBe(200)
	})

	it('rejects a removed member on the next request once their membership is evicted', async () => {
		const app = createApp()
		expect((await whoami(app, victimKey, workspaceId)).status).toBe(200)
		await db
			.delete(workspaceMembers)
			.where(
				and(eq(workspaceMembers.actorId, victimId), eq(workspaceMembers.workspaceId, workspaceId)),
			)

		evictMembership(victimId, workspaceId)

		expect((await whoami(app, victimKey, workspaceId)).status).toBe(404)
	})

	it('rejects a member the moment DELETE /workspaces/:id/members/:actorId removes them', async () => {
		const app = createApp()
		expect((await whoami(app, victimKey, workspaceId)).status).toBe(200) // warms the cache

		const removed = await app.request(
			jsonRequest('DELETE', `/api/workspaces/${workspaceId}/members/${victimId}`, undefined, {
				Authorization: `Bearer ${TEST_API_KEY}`,
			}),
		)
		expect(removed.status).toBe(200)

		expect((await whoami(app, victimKey, workspaceId)).status).toBe(404)
	})

	it('rejects the old key immediately after POST /actors/:id/api-keys rotates it', async () => {
		const app = createApp()
		expect((await whoami(app, victimKey)).status).toBe(200) // warms the key cache

		const rotated = await app.request(
			jsonRequest('POST', `/api/actors/${victimId}/api-keys`, undefined, {
				Authorization: `Bearer ${TEST_API_KEY}`,
				'X-Workspace-Id': workspaceId,
			}),
		)
		expect(rotated.status).toBe(200)
		const { api_key: newKey } = (await rotated.json()) as { api_key: string }

		expect((await whoami(app, victimKey)).status).toBe(401)
		expect((await whoami(app, newKey)).status).toBe(200)
	})

	it('rejects a deleted actor immediately once evicted', async () => {
		const app = createApp()
		expect((await whoami(app, victimKey)).status).toBe(200)
		await db.delete(workspaceMembers).where(eq(workspaceMembers.actorId, victimId))
		await db.delete(actors).where(eq(actors.id, victimId))

		evictActor(victimId)

		expect((await whoami(app, victimKey)).status).toBe(401)
	})

	it('never caches a key that was invalid, so a newly created actor works at once', async () => {
		const app = createApp()
		expect((await whoami(app, 'ank_notyetcreated')).status).toBe(401)

		await insertActor(db, { type: 'agent', apiKey: 'ank_notyetcreated' })

		expect((await whoami(app, 'ank_notyetcreated')).status).toBe(200)
	})
})
