import { objects, starState } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { resolveInitiatedFromBlock } from '../../services/session-lifecycle'
import {
	buildCreateObjectBody,
	insertActor,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: sessionsRoutes } = await import('../../routes/sessions')

// The harness calls every route as the shared test actor. Workspace A belongs to that actor and
// workspace B to a second actor, so workspace B ids and actors are foreign to every request here.
function createApp() {
	return createIntegrationApp(
		{ path: '/api/objects', module: objectsRoutes },
		{ path: '/api/sessions', module: sessionsRoutes },
	)
}

describe('By-id routes do not reach across workspaces', () => {
	let actorA: string
	let actorB: string
	let wsA: string
	let wsB: string
	let aObject: { id: string }
	let bObject: { id: string }

	beforeEach(async () => {
		actorA = getTestActorId()
		actorB = (await insertActor(db)).id
		wsA = (await insertWorkspace(db, actorA)).id
		wsB = (await insertWorkspace(db, actorB)).id
		aObject = await insertObject(db, wsA, actorA, { type: 'task', status: 'todo' })
		bObject = await insertObject(db, wsB, actorB, {
			type: 'task',
			status: 'todo',
			title: 'Workspace B private title',
		})
	})

	describe('object driver', () => {
		it('POST refuses a driver that is not a member of the workspace', async () => {
			const title = 'Driver from another workspace'
			const res = await createApp().request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ title, driver: actorB }), {
					'x-workspace-id': wsA,
				}),
			)

			expect(res.status).toBe(404)
			const created = await db.select().from(objects).where(eq(objects.title, title))
			expect(created).toHaveLength(0)
		})

		it('POST accepts a driver that is a member of the workspace', async () => {
			const res = await createApp().request(
				jsonRequest('POST', '/api/objects', buildCreateObjectBody({ driver: actorA }), {
					'x-workspace-id': wsA,
				}),
			)

			expect(res.status).toBe(201)
		})

		it('PATCH refuses a driver that is not a member and leaves the driver unchanged', async () => {
			const res = await createApp().request(
				jsonRequest('PATCH', `/api/objects/${aObject.id}`, { driver: actorB }),
			)

			expect(res.status).toBe(404)
			const [row] = await db.select().from(objects).where(eq(objects.id, aObject.id))
			expect(row?.driver).not.toBe(actorB)
		})

		it('bulk-update refuses a driver that is not a member and writes nothing', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/objects/bulk-update',
					{ ids: [aObject.id], patch: { driver: actorB } },
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const [row] = await db.select().from(objects).where(eq(objects.id, aObject.id))
			expect(row?.driver).not.toBe(actorB)
		})
	})

	describe('GET /api/objects/:id/graph', () => {
		it('omits an edge to a workspace B object, so its id and type do not come back', async () => {
			const own = await insertObject(db, wsA, actorA, { type: 'bet', status: 'opportunity' })
			const ownEdge = await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: aObject.id,
				targetType: 'object',
				targetId: own.id,
				type: 'relates_to',
			})
			// A forged or legacy edge from a workspace A object to a workspace B object.
			await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: aObject.id,
				targetType: 'object',
				targetId: bObject.id,
				type: 'informs',
			})

			const res = await createApp().request(
				jsonGet(`/api/objects/${aObject.id}/graph`, { 'x-workspace-id': wsA }),
			)

			expect(res.status).toBe(200)
			const text = await res.text()
			const body = JSON.parse(text) as { relationships: Array<{ id: string }> }
			expect(body.relationships.map((r) => r.id)).toEqual([ownEdge.id])
			expect(text).not.toContain(bObject.id)
			expect(text).not.toContain('Workspace B private title')
		})
	})

	describe('star routes', () => {
		it('answer 404 for a workspace B object, the same as for a missing one', async () => {
			const headers = { 'x-workspace-id': wsA }
			const star = await createApp().request(
				jsonRequest('POST', `/api/objects/${bObject.id}/star`, undefined, headers),
			)
			const unstar = await createApp().request(
				jsonDelete(`/api/objects/${bObject.id}/star`, headers),
			)

			expect(star.status).toBe(404)
			expect(unstar.status).toBe(404)
			const stars = await db.select().from(starState).where(eq(starState.entityId, bObject.id))
			expect(stars).toHaveLength(0)
		})
	})

	describe('sessions', () => {
		it('lean list does not take a title from a workspace B trigger', async () => {
			const bTrigger = await insertTrigger(db, wsB, actorB, actorB, {
				name: 'Workspace B private trigger',
			})
			const session = await insertSession(db, wsA, actorA, actorA, {
				triggerId: bTrigger.id,
				actionPrompt: 'Own prompt in workspace A',
			})

			const res = await createApp().request(jsonGet('/api/sessions', { 'x-workspace-id': wsA }))

			expect(res.status).toBe(200)
			const text = await res.text()
			const rows = JSON.parse(text) as Array<{ id: string; title: string }>
			expect(rows.map((r) => r.id)).toContain(session.id)
			expect(text).not.toContain('Workspace B private trigger')
		})

		it('failure context does not read the title of a workspace B object', async () => {
			const foreign = await resolveInitiatedFromBlock(db, {
				initiatedFromObjectId: bObject.id,
				workspaceId: wsA,
			})
			expect(foreign).toBeNull()

			const own = await resolveInitiatedFromBlock(db, {
				initiatedFromObjectId: aObject.id,
				workspaceId: wsA,
			})
			expect(own?.object_id).toBe(aObject.id)
		})
	})
})
