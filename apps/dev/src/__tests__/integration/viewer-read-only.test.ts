import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, mapStatusToCode } from '../../lib/errors'
import { getWorkspaceRole, isWorkspaceMember, isWorkspaceWriter } from '../../lib/workspace-auth'
import {
	buildCreateGraphBody,
	buildCreateObjectBody,
	buildCreateRelationshipBody,
	insertActor,
	insertObject,
	insertWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: graphRoutes } = await import('../../routes/graph')

// Real authMiddleware (the role comes from its membership lookup) in front of the
// real routes, so a viewer API key goes through the same path as in production.
function createApp() {
	const app = new OpenAPIHono()
	app.use('*', authMiddleware(db, { cacheTtlMs: 0 }))
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		const sessionManager = { stopSession: async () => {}, createSession: async () => ({}) }
		c.set('sessionManager' as never, sessionManager as never)
		await next()
	})
	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		throw err
	})
	app.route('/api/objects', objectsRoutes as never)
	app.route('/api/relationships', relationshipsRoutes as never)
	app.route('/api/graph', graphRoutes as never)
	return app
}

describe('Viewer role is read-only', () => {
	let workspaceId: string
	let viewerKey: string
	let viewerId: string
	let memberKey: string
	let ownerKey: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		ownerKey = 'ank_testintegration'

		const viewer = await insertActor(db, { name: 'Viewer' })
		viewerId = viewer.id
		viewerKey = viewer.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		const member = await insertActor(db, { name: 'Member' })
		memberKey = member.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })
	})

	const auth = (key: string) => ({ Authorization: `Bearer ${key}`, 'x-workspace-id': workspaceId })

	it('returns 200 to a viewer on a read route', async () => {
		const res = await createApp().request(jsonGet('/api/objects', auth(viewerKey)))
		expect(res.status).toBe(200)
	})

	it('returns 403 to a viewer and 201 to a member on POST /api/objects', async () => {
		const app = createApp()
		const body = buildCreateObjectBody()

		const asViewer = await app.request(jsonRequest('POST', '/api/objects', body, auth(viewerKey)))
		expect(asViewer.status).toBe(403)
		expect((await asViewer.json()).error.code).toBe('FORBIDDEN')

		const asMember = await app.request(jsonRequest('POST', '/api/objects', body, auth(memberKey)))
		expect(asMember.status).toBe(201)

		const asOwner = await app.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(ownerKey)),
		)
		expect(asOwner.status).toBe(201)
	})

	it('returns 403 to a viewer on by-ID writes, even without the workspace header', async () => {
		const app = createApp()
		const obj = await insertObject(db, workspaceId, getTestActorId())
		const bearerOnly = { Authorization: `Bearer ${viewerKey}` }

		const patch = await app.request(
			jsonRequest('PATCH', `/api/objects/${obj.id}`, { title: 'renamed' }, bearerOnly),
		)
		expect(patch.status).toBe(403)

		const del = await app.request(jsonDelete(`/api/objects/${obj.id}`, bearerOnly))
		expect(del.status).toBe(403)

		// Reads by ID stay open to the viewer.
		const get = await app.request(jsonGet(`/api/objects/${obj.id}`, bearerOnly))
		expect(get.status).toBe(200)
	})

	it('returns 403 to a viewer on relationship and graph writes', async () => {
		const app = createApp()

		const rel = await app.request(
			jsonRequest('POST', '/api/relationships', buildCreateRelationshipBody(), auth(viewerKey)),
		)
		expect(rel.status).toBe(403)

		const graph = await app.request(
			jsonRequest('POST', '/api/graph', buildCreateGraphBody(), auth(viewerKey)),
		)
		expect(graph.status).toBe(403)
	})

	it('lets a member write once a viewer is promoted', async () => {
		const app = createApp()
		await db
			.update(workspaceMembers)
			.set({ role: 'member' })
			.where(
				and(eq(workspaceMembers.actorId, viewerId), eq(workspaceMembers.workspaceId, workspaceId)),
			)

		const res = await app.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), auth(viewerKey)),
		)
		expect(res.status).toBe(201)
	})

	describe('workspace-auth helpers', () => {
		it('getWorkspaceRole returns the role, or null for a non-member', async () => {
			expect(await getWorkspaceRole(db, viewerId, workspaceId)).toBe('viewer')
			expect(await getWorkspaceRole(db, getTestActorId(), workspaceId)).toBe('owner')
			const stranger = await insertActor(db, { name: 'Stranger' })
			expect(await getWorkspaceRole(db, stranger.id, workspaceId)).toBeNull()
		})

		it('isWorkspaceWriter: true for writers, false for non-members, throws for viewers', async () => {
			const stranger = await insertActor(db, { name: 'Stranger' })

			expect(await isWorkspaceWriter(db, getTestActorId(), workspaceId)).toBe(true)
			expect(await isWorkspaceWriter(db, stranger.id, workspaceId)).toBe(false)
			await expect(isWorkspaceWriter(db, viewerId, workspaceId)).rejects.toMatchObject({ status: 403 })
			// isWorkspaceMember is unchanged: a viewer is still a member for reads.
			expect(await isWorkspaceMember(db, viewerId, workspaceId)).toBe(true)
		})
	})
})
