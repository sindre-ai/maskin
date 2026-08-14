import { insertObject, insertRelationship, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

describe('GET /api/objects/:id/graph/traverse (integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('returns just the start object when it has no edges', async () => {
		const app = createApp()
		const start = await insertObject(db, workspaceId, actorId, {
			type: 'insight',
			status: 'new',
		})

		const res = await app.request(
			jsonGet(`/api/objects/${start.id}/graph/traverse`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.nodes).toHaveLength(1)
		expect(body.nodes[0].id).toBe(start.id)
		expect(body.edges).toEqual([])
		expect(body.truncated).toBe(false)
		expect(body.truncated_reason).toBeNull()
	})

	it('walks outbound edges up to max_depth', async () => {
		const app = createApp()
		const a = await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active' })
		const b = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		const c = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		const d = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: a.id,
			targetId: b.id,
			type: 'breaks_into',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: b.id,
			targetId: c.id,
			type: 'breaks_into',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: c.id,
			targetId: d.id,
			type: 'breaks_into',
		})

		// depth=2 should reach c but not d
		const res = await app.request(
			jsonGet(`/api/objects/${a.id}/graph/traverse?max_depth=2&direction=outbound`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		const nodeIds = body.nodes.map((n: { id: string }) => n.id).sort()
		expect(nodeIds).toEqual([a.id, b.id, c.id].sort())
		expect(body.edges).toHaveLength(2)
		expect(body.truncated).toBe(true)
		expect(body.truncated_reason).toBe('max_depth')
	})

	it('caps at max_nodes and reports truncated_reason', async () => {
		const app = createApp()
		const hub = await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active' })
		for (let i = 0; i < 6; i++) {
			const neighbour = await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
			})
			await insertRelationship(db, actorId, {
				sourceType: 'object',
				targetType: 'object',
				sourceId: hub.id,
				targetId: neighbour.id,
				type: 'relates_to',
			})
		}

		// max_nodes=3 => start + 2 neighbours
		const res = await app.request(
			jsonGet(`/api/objects/${hub.id}/graph/traverse?max_nodes=3`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.nodes.length).toBe(3)
		expect(body.truncated).toBe(true)
		expect(body.truncated_reason).toBe('max_nodes')
	})

	it('terminates on cyclic supersedes/contradicts edges via visited set', async () => {
		const app = createApp()
		const a = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		const b = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		const c = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		// a -> b -> c -> a (3-cycle)
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: a.id,
			targetId: b.id,
			type: 'supersedes',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: b.id,
			targetId: c.id,
			type: 'contradicts',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: c.id,
			targetId: a.id,
			type: 'supersedes',
		})

		const res = await app.request(
			jsonGet(`/api/objects/${a.id}/graph/traverse?max_depth=10&direction=outbound`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		// All three nodes present exactly once — cycle didn't blow up node count.
		expect(body.nodes.map((n: { id: string }) => n.id).sort()).toEqual([a.id, b.id, c.id].sort())
		expect(body.edges).toHaveLength(3)
		expect(body.truncated).toBe(false)
	})

	it('honours edge_types allow-list', async () => {
		const app = createApp()
		const a = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		const b = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		const c = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: a.id,
			targetId: b.id,
			type: 'supersedes',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: a.id,
			targetId: c.id,
			type: 'relates_to',
		})

		const res = await app.request(
			jsonGet(`/api/objects/${a.id}/graph/traverse?edge_types=supersedes`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		const nodeIds = body.nodes.map((n: { id: string }) => n.id).sort()
		expect(nodeIds).toEqual([a.id, b.id].sort())
		expect(body.edges).toHaveLength(1)
		expect(body.edges[0].type).toBe('supersedes')
	})

	it('honours direction=inbound', async () => {
		const app = createApp()
		const parent = await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active' })
		const child = await insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: parent.id,
			targetId: child.id,
			type: 'breaks_into',
		})

		// From `child`, outbound reaches nothing; inbound reaches parent.
		const outboundRes = await app.request(
			jsonGet(`/api/objects/${child.id}/graph/traverse?direction=outbound`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(outboundRes.status).toBe(200)
		expect((await outboundRes.json()).nodes).toHaveLength(1)

		const inboundRes = await app.request(
			jsonGet(`/api/objects/${child.id}/graph/traverse?direction=inbound`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(inboundRes.status).toBe(200)
		const inboundBody = await inboundRes.json()
		expect(inboundBody.nodes.map((n: { id: string }) => n.id).sort()).toEqual(
			[parent.id, child.id].sort(),
		)
	})

	it('does not follow edges into other workspaces', async () => {
		const app = createApp()
		const otherActor = actorId // same actor is fine; separate workspace is what matters
		const otherWs = await insertWorkspace(db, otherActor)

		const a = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })
		const foreign = await insertObject(db, otherWs.id, actorId, {
			type: 'insight',
			status: 'new',
		})
		await insertRelationship(db, actorId, {
			sourceType: 'object',
			targetType: 'object',
			sourceId: a.id,
			targetId: foreign.id,
			type: 'relates_to',
		})

		const res = await app.request(
			jsonGet(`/api/objects/${a.id}/graph/traverse`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.nodes.map((n: { id: string }) => n.id)).toEqual([a.id])
		expect(body.edges).toEqual([])
	})

	it('rejects when max_depth * max_nodes exceeds the ceiling', async () => {
		const app = createApp()
		const a = await insertObject(db, workspaceId, actorId, { type: 'insight', status: 'new' })

		// 10 * 1000 = 10_000, over the 5000 ceiling.
		const res = await app.request(
			jsonGet(`/api/objects/${a.id}/graph/traverse?max_depth=10&max_nodes=1000`, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 404 when the start object is in a different workspace', async () => {
		const app = createApp()
		const otherWs = await insertWorkspace(db, actorId)
		const foreign = await insertObject(db, otherWs.id, actorId, {
			type: 'insight',
			status: 'new',
		})

		const res = await app.request(
			jsonGet(`/api/objects/${foreign.id}/graph/traverse`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(404)
	})
})
