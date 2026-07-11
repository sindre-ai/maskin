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
const { default: notificationsRoutes } = await import('../../routes/notifications')

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
	app.route('/api/notifications', notificationsRoutes)
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

		// A's view of the task: not subscribed. `unread_count` on the detail
		// endpoint is "comments since you last read this entity" and intentionally
		// doesn't gate on subscription, so it can be non-zero here — the invariant
		// we lock is the For You feed below, not the per-entity unread badge.
		const taskDetailA = await appA
			.request(jsonGet(`/api/objects/${task.id}`, headersA))
			.then((r) => r.json())
		expect(taskDetailA.is_subscribed).toBe(false)

		// A's For You: the task must NOT appear. The bet has no comment activity
		// of its own, so the unread feed should be empty for A.
		const unreadA = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		const taskIds = unreadA.items.map((i: { entity_id: string }) => i.entity_id)
		expect(taskIds).not.toContain(task.id)
	})

	it('a bet watcher receives the terminal status_changed signal in unread + notifications', async () => {
		// T2 on bet/notif-cascade-fix: when a bet flips to succeeded/failed, every
		// subscribed actor must (1) see the bet in their /api/subscriptions/unread
		// feed and (2) get a notifications row. Without this, watchers miss the
		// terminal signal — the bet's own kill_threshold.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		// A creates a bet (auto-subscribed as 'author'). B manually subscribes so
		// we exercise the fan-out across two subscribers.
		const betRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'bet', title: 'Watched bet', status: 'active' }),
				headersA,
			),
		)
		expect(betRes.status).toBe(201)
		const bet = await betRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: bet.id },
				headersB,
			),
		)

		// A flips the bet to succeeded. The actor making the flip (A) should NOT
		// be notified — you don't notify yourself about your own action.
		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'succeeded' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		// B's For You: the bet appears with unread_count=1, latest_event is the
		// status_changed event. This is what the For You panel reads.
		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === bet.id)
		expect(itemB).toBeDefined()
		expect(itemB.unread_count).toBe(1)

		// A's For You: A made the change, so the bet should NOT appear in their
		// unread feed for this transition.
		const unreadA = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		const itemA = unreadA.items.find((i: { entity_id: string }) => i.entity_id === bet.id)
		expect(itemA).toBeUndefined()

		// B gets a `good_news` notification row pointing at the bet. A does not
		// (they made the flip). The list endpoint serializes Drizzle records as-is
		// (camelCase keys), so target_actor_id surfaces as targetActorId.
		const notifsForB = await appB
			.request(jsonGet(`/api/notifications?object_id=${bet.id}`, headersB))
			.then((r) => r.json())
		const bGoodNews = notifsForB.find(
			(n: { type: string; targetActorId: string }) =>
				n.type === 'good_news' && n.targetActorId === bId,
		)
		expect(bGoodNews).toBeDefined()
		expect(bGoodNews.title).toContain('succeeded')
		expect(bGoodNews.objectId).toBe(bet.id)
		expect(bGoodNews.status).toBe('pending')

		const aGoodNews = notifsForB.find(
			(n: { type: string; targetActorId: string }) =>
				n.type === 'good_news' && n.targetActorId === aId,
		)
		expect(aGoodNews).toBeUndefined()
	})

	it('a bet watcher receives the failed signal even when the bet has no other activity', async () => {
		// Failure mode covered: a long-running bet that flips straight from active
		// to failed with no comments in between must still surface in the
		// watcher's unread feed. Without (2) in the unread join condition this
		// returns an empty feed because the entity has no `commented` events.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const betRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'bet', title: 'Silent bet', status: 'active' }),
				headersA,
			),
		)
		const bet = await betRes.json()

		// B subscribes manually; no comments are ever posted.
		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: bet.id },
				headersB,
			),
		)

		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'failed' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === bet.id)
		expect(itemB).toBeDefined()
		expect(itemB.unread_count).toBe(1)
		expect(itemB.mentioning_unread_count).toBe(0)

		const notifsForB = await appB
			.request(jsonGet(`/api/notifications?object_id=${bet.id}`, headersB))
			.then((r) => r.json())
		const bAlert = notifsForB.find(
			(n: { type: string; targetActorId: string }) => n.type === 'alert' && n.targetActorId === bId,
		)
		expect(bAlert).toBeDefined()
		expect(bAlert.title).toContain('failed')
	})

	it('a bet watcher receives the paused signal, same as succeeded/failed', async () => {
		// 'paused' is a terminal bet status alongside succeeded/failed (see
		// TERMINAL_BET_STATUSES in packages/shared/src/schemas/objects.ts and the
		// Retro & Knowledge Author's "bet reaches a terminal status (succeeded,
		// failed, or paused)" trigger in packages/db/src/seed.ts) — a paused bet
		// with no comment activity must still surface in the watcher's unread
		// feed and get a notification row, exactly like succeeded/failed.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const betRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'bet', title: 'Paused bet', status: 'active' }),
				headersA,
			),
		)
		const bet = await betRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: bet.id },
				headersB,
			),
		)

		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'paused' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === bet.id)
		expect(itemB).toBeDefined()
		expect(itemB.unread_count).toBe(1)

		const notifsForB = await appB
			.request(jsonGet(`/api/notifications?object_id=${bet.id}`, headersB))
			.then((r) => r.json())
		const bAlert = notifsForB.find(
			(n: { type: string; targetActorId: string }) => n.type === 'alert' && n.targetActorId === bId,
		)
		expect(bAlert).toBeDefined()
		expect(bAlert.title).toContain('paused')
	})

	it('concurrent PATCHes flipping the same bet to succeeded notify each subscriber exactly once', async () => {
		// Regression test for the TOCTOU race: the terminal-notification guard
		// used to compare against a pre-transaction `existing` snapshot, so two
		// concurrent PATCHes could both observe the pre-transition status and
		// both fan out. The fix re-reads the row under FOR UPDATE inside the
		// transaction, so the second PATCH blocks on the row lock and then
		// observes the already-terminal status.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const betRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'bet', title: 'Racy bet', status: 'active' }),
				headersA,
			),
		)
		const bet = await betRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: bet.id },
				headersB,
			),
		)

		// Fire two concurrent PATCHes flipping the same bet to 'succeeded'.
		const [res1, res2] = await Promise.all([
			appA.request(
				jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'succeeded' }, headersA),
			),
			appA.request(
				jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'succeeded' }, headersA),
			),
		])
		expect(res1.status).toBe(200)
		expect(res2.status).toBe(200)

		const notifsForB = await appB
			.request(jsonGet(`/api/notifications?object_id=${bet.id}`, headersB))
			.then((r) => r.json())
		const bGoodNews = notifsForB.filter(
			(n: { type: string; targetActorId: string }) =>
				n.type === 'good_news' && n.targetActorId === bId,
		)
		expect(bGoodNews).toHaveLength(1)
	})

	it('non-terminal bet status changes do NOT trigger watcher notifications', async () => {
		// Guards against accidentally widening the trigger to every status_changed
		// event. proposed → active is part of the normal bet lifecycle and must
		// not page watchers.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const betRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({ type: 'bet', title: 'Lifecycle bet', status: 'proposed' }),
				headersA,
			),
		)
		const bet = await betRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: bet.id },
				headersB,
			),
		)

		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'active' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === bet.id)
		expect(itemB).toBeUndefined()

		const notifsForB = await appB
			.request(jsonGet(`/api/notifications?object_id=${bet.id}`, headersB))
			.then((r) => r.json())
		expect(notifsForB).toEqual([])
	})

	it('counts mentioning unread events per-event grain, never rolls up to an object-level mention flag', async () => {
		// Regression test for the per-comment vs per-object mention rollup (T5 on
		// bet/notif-cascade-fix). One @mention of A among nine non-mentioning
		// comments on the same object used to surface as "the whole object
		// mentions you" via a bool_or aggregate. Now: mentioning_unread_count = 1,
		// unread_count = 10, and the legacy mentions_you boolean is gone.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const createRes = await appA.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA),
		)
		const obj = await createRes.json()

		// B comments nine times without mentioning A.
		for (let i = 0; i < 9; i++) {
			const r = await appB.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: obj.id, content: `agent chatter ${i}` },
					headersB,
				),
			)
			expect(r.status).toBe(201)
		}

		// B posts one comment that actually @-mentions A.
		const mentioningRes = await appB.request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: obj.id, content: 'hey there', mentions: [aId] },
				headersB,
			),
		)
		expect(mentioningRes.status).toBe(201)

		const unreadA = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		const itemA = unreadA.items.find((i: { entity_id: string }) => i.entity_id === obj.id)
		expect(itemA).toBeDefined()
		expect(itemA.unread_count).toBe(10)
		expect(itemA.mentioning_unread_count).toBe(1)
		// The legacy object-level rollup boolean must not be present.
		expect('mentions_you' in itemA).toBe(false)
	})

	it("agent-to-agent mentions on a shared object never raise a human watcher's mentioning count", async () => {
		// The bet's commitment: agent→agent mentions route to the target agent via
		// the per-event notification path and never surface to a human's For You.
		// Reuse B as a stand-in for "another agent" mentioned in passing.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		// A (human) creates the object and is auto-subscribed.
		const createRes = await appA.request(
			jsonRequest('POST', '/api/objects', buildCreateObjectBody(), headersA),
		)
		const obj = await createRes.json()

		// B posts a comment that mentions B themselves (i.e. an agent→agent
		// mention that does not target A). A should see the unread but their
		// mentioning count must stay at zero.
		const commentRes = await appB.request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: obj.id, content: 'agent ping', mentions: [bId] },
				headersB,
			),
		)
		expect(commentRes.status).toBe(201)

		const unreadA = await appA
			.request(jsonGet('/api/subscriptions/unread', headersA))
			.then((r) => r.json())
		const itemA = unreadA.items.find((i: { entity_id: string }) => i.entity_id === obj.id)
		expect(itemA).toBeDefined()
		expect(itemA.unread_count).toBe(1)
		expect(itemA.mentioning_unread_count).toBe(0)
	})

	it('a loop watcher receives the at-risk transition signal in unread', async () => {
		// T2 on bet/loops-primitive: when a Loop flips to a signalling status
		// (at-risk or breached), subscribers must see it in For You just like
		// bet terminal transitions — SIGNALLING_LOOP_STATUSES is the shared
		// source of truth. Without this, watchers can't tell a Loop from a
		// noisy 'updated' event and the parent bet's ship metric (every Loop
		// viewed weekly) can't rely on the feed.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const loopRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({
					type: 'loop',
					title: 'Customer bugs fixed <1 day',
					status: 'holding',
				}),
				headersA,
			),
		)
		expect(loopRes.status).toBe(201)
		const loop = await loopRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: loop.id },
				headersB,
			),
		)

		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${loop.id}`, { status: 'at-risk' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === loop.id)
		expect(itemB).toBeDefined()
		expect(itemB.unread_count).toBe(1)
		expect(itemB.mentioning_unread_count).toBe(0)
	})

	it('a loop watcher receives the breached signal even with no other activity', async () => {
		// Silent-Loop failure mode: a Loop that flips straight from holding to
		// breached with no comments must still land in the watcher's feed.
		// Mirrors the "silent bet" case for TERMINAL_BET_STATUSES.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const loopRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({
					type: 'loop',
					title: 'Weekly release cadence',
					status: 'holding',
				}),
				headersA,
			),
		)
		const loop = await loopRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: loop.id },
				headersB,
			),
		)

		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${loop.id}`, { status: 'breached' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === loop.id)
		expect(itemB).toBeDefined()
		expect(itemB.unread_count).toBe(1)
	})

	it('a loop transition back to holding does NOT surface in the watcher feed', async () => {
		// Ranking guarantee for the feed: only at-risk / breached transitions
		// count as signalling. A recovery to holding is routine lifecycle noise
		// and must not page a watcher — this is what keeps at-risk/breached
		// ranked above holding without a Loop-only ranker.
		const appA = appAs(aId)
		const appB = appAs(bId)
		const headersA = { 'x-workspace-id': workspaceId }
		const headersB = { 'x-workspace-id': workspaceId }

		const loopRes = await appA.request(
			jsonRequest(
				'POST',
				'/api/objects',
				buildCreateObjectBody({
					type: 'loop',
					title: 'Onboarding TTFV',
					status: 'at-risk',
				}),
				headersA,
			),
		)
		const loop = await loopRes.json()

		await appB.request(
			jsonRequest(
				'POST',
				'/api/subscriptions',
				{ entity_type: 'object', entity_id: loop.id },
				headersB,
			),
		)

		const patchRes = await appA.request(
			jsonRequest('PATCH', `/api/objects/${loop.id}`, { status: 'holding' }, headersA),
		)
		expect(patchRes.status).toBe(200)

		const unreadB = await appB
			.request(jsonGet('/api/subscriptions/unread', headersB))
			.then((r) => r.json())
		const itemB = unreadB.items.find((i: { entity_id: string }) => i.entity_id === loop.id)
		expect(itemB).toBeUndefined()
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
