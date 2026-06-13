import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import { createApiError, formatZodError } from '../../lib/errors'
import type { SessionManager } from '../../services/session-manager'
import { buildCreateObjectBody, insertActor, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

const { default: subscriptionsRoutes } = await import('../../routes/subscriptions')
const { default: objectsRoutes } = await import('../../routes/objects')
const { default: eventsRoutes } = await import('../../routes/events')
const { default: graphRoutes } = await import('../../routes/graph')
const { default: relationshipsRoutes } = await import('../../routes/relationships')

// Mock session manager — we don't exercise container startup in this test, but
// the events route reads c.get('sessionManager') for @mention handling. Empty
// mock is fine because we never @mention in this test.
const mockSessionManager = {
	createSession: async () => ({ id: 'noop' }),
	stopSession: async () => undefined,
	pauseSession: async () => undefined,
	resumeSession: async () => undefined,
	writeInput: async () => undefined,
	on: () => undefined,
	off: () => undefined,
} as unknown as SessionManager

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', mockSessionManager)
		await next()
	})
	app.route('/api/objects', objectsRoutes)
	app.route('/api/subscriptions', subscriptionsRoutes)
	app.route('/api/events', eventsRoutes)
	app.route('/api/graph', graphRoutes)
	app.route('/api/relationships', relationshipsRoutes)
	return app
}

describe('Subscriptions Integration', () => {
	let workspaceId: string
	let aId: string
	let bId: string

	beforeEach(async () => {
		aId = getTestActorId()
		const ws = await insertWorkspace(db, aId)
		workspaceId = ws.id

		const b = await insertActor(db, {
			name: 'Actor B',
			email: `b-${Date.now()}@test.com`,
			apiKey: `ank_b_${Date.now()}`,
		})
		bId = b.id
		// Add B as a member of the same workspace.
		await db
			.insert((await import('@maskin/db/schema')).workspaceMembers)
			.values({ workspaceId, actorId: bId, role: 'member' })
	})

	it('auto-subscribes the creator and any commenter; unread tracks correctly', async () => {
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		// A creates an object → A is auto-subscribed as 'author'.
		const createRes = await appA.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA),
		)
		expect(createRes.status).toBe(201)
		const obj = await createRes.json()

		// A's detail view: is_subscribed=true, unread=0, subscriber_count=1.
		const detailA1 = await appA
			.request(jsonGet(`/api/objects/${obj.id}`, headersA))
			.then((r) => r.json())
		expect(detailA1.is_subscribed).toBe(true)
		expect(detailA1.unread_count).toBe(0)
		expect(detailA1.subscriber_count).toBe(1)

		// B has not commented yet → B is not subscribed, unread=0.
		const detailB1 = await appB
			.request(jsonGet(`/api/objects/${obj.id}`, headersB))
			.then((r) => r.json())
		expect(detailB1.is_subscribed).toBe(false)
		expect(detailB1.unread_count).toBe(0)

		// B comments → B is auto-subscribed; A now has unread=1.
		const commentRes = await appB.request(
			jsonRequest('POST', '/api/events', { entity_id: obj.id, content: "B's comment" }, headersB),
		)
		expect(commentRes.status).toBe(201)
		const bComment = await commentRes.json()

		const detailA2 = await appA
			.request(jsonGet(`/api/objects/${obj.id}`, headersA))
			.then((r) => r.json())
		expect(detailA2.unread_count).toBe(1)
		expect(detailA2.subscriber_count).toBe(2)
		expect(detailA2.is_subscribed).toBe(true)

		// B doesn't see their own comment as unread.
		const detailB2 = await appB
			.request(jsonGet(`/api/objects/${obj.id}`, headersB))
			.then((r) => r.json())
		expect(detailB2.is_subscribed).toBe(true)
		expect(detailB2.unread_count).toBe(0)

		// A's Pulse: unread feed lists the object.
		const unreadA = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		expect(unreadA.items).toHaveLength(1)
		expect(unreadA.items[0].entity_id).toBe(obj.id)
		expect(unreadA.items[0].unread_count).toBe(1)

		// A marks read up to the comment event id.
		const markRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/subscriptions/read',
				{ entity_type: 'object', entity_id: obj.id, last_event_id: bComment.id },
				headersA,
			),
		)
		expect(markRes.status).toBe(200)

		// A's unread is now 0; Pulse feed empties.
		const detailA3 = await appA
			.request(jsonGet(`/api/objects/${obj.id}`, headersA))
			.then((r) => r.json())
		expect(detailA3.unread_count).toBe(0)

		const unreadAfter = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		expect(unreadAfter.items).toEqual([])
	})

	it('mark_read never moves the high-water-mark backward', async () => {
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const createRes = await appA.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA),
		)
		const obj = await createRes.json()

		const c1 = await appB
			.request(jsonRequest('POST', '/api/events', { entity_id: obj.id, content: '1' }, headersB))
			.then((r) => r.json())
		const c2 = await appB
			.request(jsonRequest('POST', '/api/events', { entity_id: obj.id, content: '2' }, headersB))
			.then((r) => r.json())

		// Read up to c2 first, then try to read up to c1 — should not regress.
		await appA.request(
			jsonRequest(
				'POST',
				'/api/subscriptions/read',
				{ entity_type: 'object', entity_id: obj.id, last_event_id: c2.id },
				headersA,
			),
		)
		await appA.request(
			jsonRequest(
				'POST',
				'/api/subscriptions/read',
				{ entity_type: 'object', entity_id: obj.id, last_event_id: c1.id },
				headersA,
			),
		)

		const detail = await appA
			.request(jsonGet(`/api/objects/${obj.id}`, headersA))
			.then((r) => r.json())
		expect(detail.unread_count).toBe(0)
	})

	it('manual subscribe / unsubscribe round trip', async () => {
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const createRes = await appA.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA),
		)
		const obj = await createRes.json()

		// B manually subscribes.
		const subRes = await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: obj.id },
				headersB,
			),
		)
		expect(subRes.status).toBe(201)

		const detail1 = await appB
			.request(jsonGet(`/api/objects/${obj.id}`, headersB))
			.then((r) => r.json())
		expect(detail1.is_subscribed).toBe(true)
		expect(detail1.subscriber_count).toBe(2)

		// B unsubscribes.
		const unsubRes = await appB.request(
			jsonRequest(
				'DELETE',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: obj.id },
				headersB,
			),
		)
		expect(unsubRes.status).toBe(200)

		const detail2 = await appB
			.request(jsonGet(`/api/objects/${obj.id}`, headersB))
			.then((r) => r.json())
		expect(detail2.is_subscribed).toBe(false)
		expect(detail2.subscriber_count).toBe(1)
	})

	it('a watcher of a bet is NOT subscribed to its child tasks via breaks_into', async () => {
		// Locks the invariant behind the "stop bet→task notification cascade" bet:
		// subscribing to a bet must never surface its child tasks' activity in the
		// watcher's For You unless the watcher is directly involved with the task.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		// A creates a bet → A is auto-subscribed as 'author'.
		const betRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'bet', title: 'Parent bet', status: 'active' }),
				headersA,
			),
		)
		expect(betRes.status).toBe(201)
		const bet = await betRes.json()

		// B creates a task → B is auto-subscribed; A is NOT.
		const taskRes = await appB.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'task', title: 'Child task', status: 'todo' }),
				headersB,
			),
		)
		expect(taskRes.status).toBe(201)
		const task = await taskRes.json()

		// Link bet → task via `breaks_into`. This must not subscribe A to the task.
		const relRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'object',
					source_id: bet.id,
					target_type: 'object',
					target_id: task.id,
					type: 'breaks_into',
				},
				headersA,
			),
		)
		expect(relRes.status).toBe(201)

		// B comments on the task with NO @mention of A. The cascade we're guarding
		// against would surface this in A's For You via bet-membership.
		const commentRes = await appB.request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: task.id, content: 'progress update on the task' },
				headersB,
			),
		)
		expect(commentRes.status).toBe(201)

		// A's view of the task: not subscribed, unread=0.
		const taskDetailA = await appA
			.request(jsonGet(`/api/objects/${task.id}`, headersA))
			.then((r) => r.json())
		expect(taskDetailA.is_subscribed).toBe(false)
		expect(taskDetailA.unread_count).toBe(0)

		// A's For You: the task must NOT appear. The bet has no comment activity
		// of its own, so the unread feed should be empty for A.
		const unreadA = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		const taskIds = unreadA.items.map((i: { entity_id: string }) => i.entity_id)
		expect(taskIds).not.toContain(task.id)
	})

	it('auto-subscribes the creator to every node created via POST /api/graph', async () => {
		const appA = appAs(aId)
		const headersA = { 'x-workspace-id': workspaceId }

		const graphRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [
						{ $id: 'bet-1', type: 'bet', title: 'Bet via graph', status: 'proposed' },
						{ $id: 'task-1', type: 'task', title: 'Task via graph', status: 'todo' },
					],
					edges: [{ source: 'bet-1', target: 'task-1', type: 'breaks_into' }],
				},
				headersA,
			),
		)
		expect(graphRes.status).toBe(201)
		const { nodes } = await graphRes.json()
		expect(nodes).toHaveLength(2)

		for (const node of nodes) {
			const detail = await appA
				.request(jsonGet(`/api/objects/${node.id}`, headersA))
				.then((r) => r.json())
			expect(detail.is_subscribed).toBe(true)
			expect(detail.subscriber_count).toBe(1)
		}
	})
})

// Silence "unused import" complaints for helpers we kept around for future tests.
void jsonDelete
