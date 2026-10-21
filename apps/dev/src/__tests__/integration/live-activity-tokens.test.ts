import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	conversations,
	deviceTokens,
	liveActivityCards,
	liveActivityTokens,
	sessionLogs,
	sessions,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { validationFailureHook } from '../../lib/errors'
import { type ApnsRequest, ApnsSender, type ApnsTransport } from '../../services/apns'
import { LiveActivityFanout } from '../../services/live-activity-push'
import type { SessionTurnEvent } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: devicesRoutes } = await import('../../routes/devices')
const { default: liveActivityRoutes } = await import('../../routes/live-activities')

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/devices', devicesRoutes)
	app.route('/api/live-activities', liveActivityRoutes)
	return app
}

const hex = (n = 64) =>
	[...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')

async function registerDevice(actorId: string, environment: 'sandbox' | 'production' = 'sandbox') {
	const res = await appAs(actorId).request(
		jsonRequest('POST', '/api/devices', {
			platform: 'ios',
			apns_token: hex(),
			environment,
		}),
	)
	expect(res.status).toBe(200)
	return (await res.json()) as { id: string }
}

const register = (
	actorId: string,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
) => appAs(actorId).request(jsonRequest('POST', '/api/live-activities/tokens', body, headers))

describe('live_activity_tokens routes (real Postgres)', () => {
	let human: string
	let stranger: string
	let workspaceId: string

	beforeEach(async () => {
		human = (await insertActor(db, { type: 'human' }))?.id as string
		stranger = (await insertActor(db, { type: 'human' }))?.id as string
		workspaceId = (await insertWorkspace(db, human)).id
	})

	it('upserts the push-to-start token per device (rotation keeps one row)', async () => {
		const device = await registerDevice(human)
		const first = await register(human, {
			kind: 'push_to_start',
			device_id: device.id,
			token: hex(120),
		})
		expect(first.status).toBe(200)
		const rotated = hex(120)
		const second = await register(human, {
			kind: 'push_to_start',
			device_id: device.id,
			token: rotated,
		})
		expect(second.status).toBe(200)

		const rows = await db
			.select()
			.from(liveActivityTokens)
			.where(eq(liveActivityTokens.deviceId, device.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.token).toBe(rotated)
		expect(rows[0]?.kind).toBe('push_to_start')
		expect(rows[0]?.workspaceId).toBeNull()
	})

	it('stores the update token against the X-Workspace-Id workspace and writes an audit event', async () => {
		const device = await registerDevice(human)
		const body = { kind: 'update', device_id: device.id }
		const token = hex(100)
		const first = await register(human, { ...body, token }, { 'X-Workspace-Id': workspaceId })
		expect(first.status).toBe(200)
		// Registering the same token again is an update, not a duplicate.
		await register(human, { ...body, token }, { 'X-Workspace-Id': workspaceId })

		const rows = await db
			.select()
			.from(liveActivityTokens)
			.where(eq(liveActivityTokens.workspaceId, workspaceId))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.token).toBe(token)

		const audit = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityType, 'live_activity_token'),
					eq(events.entityId, rows[0]?.id as string),
				),
			)
		expect(audit.map((e) => e.action).sort()).toEqual(['created', 'updated'])
		// The token itself must never land in the (workspace-wide) events feed.
		expect(JSON.stringify(audit)).not.toContain(token)
	})

	it('keeps the old update token until the app deletes it when a new activity mints another', async () => {
		const device = await registerDevice(human)
		const headers = { 'X-Workspace-Id': workspaceId }
		const a = (await (
			await register(human, { kind: 'update', device_id: device.id, token: hex(100) }, headers)
		).json()) as { id: string }
		const b = (await (
			await register(human, { kind: 'update', device_id: device.id, token: hex(100) }, headers)
		).json()) as { id: string }
		expect(a.id).not.toBe(b.id)
		expect(
			await db
				.select()
				.from(liveActivityTokens)
				.where(eq(liveActivityTokens.workspaceId, workspaceId)),
		).toHaveLength(2)
	})

	it('rejects a foreign device, a missing header and a workspace the caller is not in', async () => {
		const device = await registerDevice(human)
		const foreignDevice = await registerDevice(stranger)
		expect(
			(await register(stranger, { kind: 'push_to_start', device_id: device.id, token: hex(100) }))
				.status,
		).toBe(404)

		expect(
			(await register(human, { kind: 'update', device_id: device.id, token: hex(100) })).status,
		).toBe(400)

		// stranger owns the device but is not a member of the workspace.
		expect(
			(
				await register(
					stranger,
					{ kind: 'update', device_id: foreignDevice.id, token: hex(100) },
					{ 'X-Workspace-Id': workspaceId },
				)
			).status,
		).toBe(404)
		expect(await db.select().from(liveActivityTokens)).not.toContainEqual(
			expect.objectContaining({ actorId: stranger }),
		)
	})

	it('validates the kind pairing and hex tokens at the boundary (400) and at the DB (CHECK)', async () => {
		const device = await registerDevice(human)
		expect(
			(
				await register(human, {
					kind: 'push_to_start',
					device_id: device.id,
					session_id: '11111111-1111-4111-8111-111111111111',
					token: hex(100),
				})
			).status,
		).toBe(400)
		expect(
			(
				await register(human, {
					kind: 'push_to_start',
					device_id: device.id,
					token: 'zz'.repeat(30),
				})
			).status,
		).toBe(400)

		await expect(
			db.insert(liveActivityTokens).values({
				actorId: human,
				deviceId: device.id,
				kind: 'update',
				token: hex(100),
				workspaceId: null,
			}),
		).rejects.toThrow()
	})

	it('cascades with the device and the actor', async () => {
		const deviceA = await registerDevice(human)
		const deviceB = await registerDevice(human)
		await register(
			human,
			{ kind: 'update', device_id: deviceA.id, token: hex(100) },
			{ 'X-Workspace-Id': workspaceId },
		)
		await register(human, { kind: 'push_to_start', device_id: deviceB.id, token: hex(100) })

		await db.delete(deviceTokens).where(eq(deviceTokens.id, deviceB.id))
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.deviceId, deviceB.id)),
		).toHaveLength(0)
		await db.delete(deviceTokens).where(eq(deviceTokens.id, deviceA.id))
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.deviceId, deviceA.id)),
		).toHaveLength(0)

		// An actor with no workspace writes no audit event, so it can be deleted outright.
		const solo = (await insertActor(db, { type: 'human' }))?.id as string
		const soloDevice = await registerDevice(solo)
		await register(solo, { kind: 'push_to_start', device_id: soloDevice.id, token: hex(100) })
		await db.delete(actors).where(eq(actors.id, solo))
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.actorId, solo)),
		).toHaveLength(0)
	})

	it('drops the previous owner’s Live Activity tokens when the device changes hands', async () => {
		const token = hex()
		const reg = (actorId: string) =>
			appAs(actorId).request(
				jsonRequest('POST', '/api/devices', {
					platform: 'ios',
					apns_token: token,
					environment: 'sandbox',
				}),
			)
		const device = (await (await reg(human)).json()) as { id: string }
		await register(human, { kind: 'push_to_start', device_id: device.id, token: hex(100) })
		await register(
			human,
			{ kind: 'update', device_id: device.id, token: hex(100) },
			{ 'X-Workspace-Id': workspaceId },
		)
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.deviceId, device.id)),
		).toHaveLength(2)

		expect((await reg(stranger)).status).toBe(200)

		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.deviceId, device.id)),
		).toHaveLength(0)
	})

	it('deletes only the owner’s token', async () => {
		const device = await registerDevice(human)
		const res = await register(human, {
			kind: 'push_to_start',
			device_id: device.id,
			token: hex(100),
		})
		const { id } = (await res.json()) as { id: string }
		expect(
			(await appAs(stranger).request(jsonRequest('DELETE', `/api/live-activities/tokens/${id}`)))
				.status,
		).toBe(404)
		expect(
			(await appAs(human).request(jsonRequest('DELETE', `/api/live-activities/tokens/${id}`)))
				.status,
		).toBe(200)
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.id, id)),
		).toHaveLength(0)
	})
})

describe('Agents working Live Activity (real Postgres, fake APNs transport)', () => {
	let human: string
	let agentA: string
	let agentB: string
	let workspaceId: string
	let requests: ApnsRequest[]
	let fanout: LiveActivityFanout

	const transport: ApnsTransport = {
		send: async (req) => {
			requests.push(req)
			return { status: 200, body: '' }
		},
	}
	const bodies = () => requests.map((r) => JSON.parse(r.body).aps)
	const lifecycle = (action: string, entityId = 'unused') => ({
		workspace_id: workspaceId,
		actor_id: agentA,
		action,
		entity_type: 'session',
		entity_id: entityId,
		event_id: '1',
	})

	const newSession = (actorId: string, over: Record<string, unknown> = {}) =>
		insertSession(db, workspaceId, actorId, human, {
			status: 'running',
			interactive: false,
			currentActivity: 'Reading the brief',
			startedAt: new Date(),
			...over,
		})

	beforeEach(async () => {
		requests = []
		human = (await insertActor(db, { type: 'human' }))?.id as string
		agentA = (await insertActor(db, { type: 'agent', name: 'Chief of Staff' }))?.id as string
		agentB = (await insertActor(db, { type: 'agent', name: 'Gig Scout' }))?.id as string
		workspaceId = (await insertWorkspace(db, human)).id
		const sender = new ApnsSender(db, {
			config: { keyId: 'K', teamId: 'T', privateKey: 'unused', bundleId: 'io.maskin.app' },
			transport,
		})
		// The JWT is irrelevant to the fake transport; skip real signing.
		;(sender as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		fanout = new LiveActivityFanout(db, new EventEmitter() as unknown as PgNotifyBridge, sender, {
			throttleMs: 0,
		})
	})

	async function pushToStart(actorId = human) {
		const device = await registerDevice(actorId)
		await appAs(actorId).request(
			jsonRequest('POST', '/api/live-activities/tokens', {
				kind: 'push_to_start',
				device_id: device.id,
				token: hex(100),
			}),
		)
		return device
	}
	const updateToken = (device: { id: string }, actorId = human) =>
		register(
			actorId,
			{ kind: 'update', device_id: device.id, token: hex(100) },
			{ 'X-Workspace-Id': workspaceId },
		)
	const cardRows = () =>
		db.select().from(liveActivityCards).where(eq(liveActivityCards.workspaceId, workspaceId))

	it('starts ONE aggregate activity shaped exactly like AgentsActivityState', async () => {
		const conversationId = (await insertConversation(db, workspaceId, human)).id
		await db
			.update(conversations)
			.set({ title: `  ${'Q3 pricing review '.repeat(8)}` })
			.where(eq(conversations.id, conversationId))
		const s = await newSession(agentA, { conversationId })
		await pushToStart()

		await fanout.handleEvent(lifecycle('session_started', s.id))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers['apns-push-type']).toBe('liveactivity')
		expect(requests[0]?.headers['apns-topic']).toBe('io.maskin.app.push-type.liveactivity')
		expect(requests[0]?.headers['apns-priority']).toBe('10')

		const aps = bodies()[0]
		expect(aps.event).toBe('start')
		expect(aps['attributes-type']).toBe('MaskinAgentsAttributes')
		expect(aps.attributes).toEqual({ workspaceId })
		expect(aps.alert).toEqual({ title: 'Chief of Staff', body: 'Reading the brief' })
		expect(Object.keys(aps['content-state']).sort()).toEqual(['agents', 'count', 'finishingSoon'])
		expect(aps['content-state'].count).toBe(1)
		expect(aps['content-state'].finishingSoon).toBe(0)
		const row = aps['content-state'].agents[0]
		expect(Object.keys(row).sort()).toEqual([
			'conversationId',
			'doing',
			'id',
			'name',
			'sessionId',
			'startedAt',
			'topic',
			'touchesCustomersOrProduction',
		])
		expect(row).toMatchObject({
			id: agentA,
			sessionId: s.id,
			name: 'Chief of Staff',
			doing: 'Reading the brief',
			conversationId,
			touchesCustomersOrProduction: false,
		})
		expect(row.topic.length).toBeLessThanOrEqual(60)
		expect(row.topic.startsWith('Q3 pricing review')).toBe(true)
		// Swift reference seconds, not unix seconds.
		expect(row.startedAt).toBeLessThan(Date.now() / 1000 - 978_307_200 + 5)
		expect(row.startedAt).toBeGreaterThan(Date.now() / 1000 - 978_307_200 - 60)
		expect(aps['stale-date']).toBeGreaterThan(aps.timestamp)
		expect(await cardRows()).toHaveLength(1)
	})

	it('folds sessions into one row per agent and counts agents, not sessions', async () => {
		const first = await newSession(agentA, { startedAt: new Date(Date.now() - 60_000) })
		await newSession(agentA)
		await newSession(agentB)
		await pushToStart()

		await fanout.handleEvent(lifecycle('session_started', first.id))
		const state = bodies()[0]['content-state']
		expect(state.count).toBe(2)
		expect(state.agents).toHaveLength(2)
		// Ranked: no finish times, so the longest-running agent leads, and its row is its first session.
		expect(state.agents[0]).toMatchObject({ id: agentA, sessionId: first.id })
		expect(bodies()[0].alert).toEqual({ title: '2 agents working' })
	})

	it('sends updates to the update token only, and nothing when the state did not change', async () => {
		const s = await newSession(agentA)
		const device = await pushToStart()
		await fanout.handleEvent(lifecycle('session_started', s.id))
		await updateToken(device)
		requests.length = 0

		await fanout.handleEvent(lifecycle('session_started', s.id))
		expect(requests).toHaveLength(0)

		await db
			.update(sessions)
			.set({ currentActivity: 'Drafting the reply' })
			.where(eq(sessions.id, s.id))
		await fanout.handleEvent(lifecycle('session_updated', s.id))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers['apns-priority']).toBe('5')
		expect(bodies()[0]).toMatchObject({
			event: 'update',
			'content-state': { count: 1, agents: [{ doing: 'Drafting the reply' }] },
		})
		expect(bodies()[0].alert).toBeUndefined()
		expect(bodies()[0]['attributes-type']).toBeUndefined()
	})

	it('ends when the last agent stops, then removes the update tokens and the card', async () => {
		const a = await newSession(agentA)
		const b = await newSession(agentB)
		const device = await pushToStart()
		await fanout.handleEvent(lifecycle('session_started', a.id))
		await updateToken(device)

		requests.length = 0
		await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, a.id))
		await fanout.handleEvent(lifecycle('session_completed', a.id))
		expect(bodies()[0]).toMatchObject({ event: 'update', 'content-state': { count: 1 } })

		requests.length = 0
		await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, b.id))
		await fanout.handleEvent(lifecycle('session_completed', b.id))
		expect(bodies()).toHaveLength(1)
		expect(bodies()[0]).toMatchObject({
			event: 'end',
			'content-state': { count: 0, finishingSoon: 0, agents: [] },
		})
		expect(bodies()[0]['dismissal-date']).toBe(bodies()[0].timestamp + 60)
		expect(requests[0]?.headers['apns-priority']).toBe('10')
		expect(
			await db
				.select()
				.from(liveActivityTokens)
				.where(eq(liveActivityTokens.workspaceId, workspaceId)),
		).toHaveLength(0)
		expect(await cardRows()).toHaveLength(0)
	})

	it('holds the end until the update token registers, then sends it once', async () => {
		const s = await newSession(agentA)
		const device = await pushToStart()
		fanout.start()
		try {
			await fanout.handleEvent(lifecycle('session_started', s.id))
			requests.length = 0

			// The agent finishes before the app ever registered the card's update token.
			await db.update(sessions).set({ status: 'completed' }).where(eq(sessions.id, s.id))
			await fanout.handleEvent(lifecycle('session_completed', s.id))
			expect(requests).toHaveLength(0)
			expect((await cardRows())[0]?.endPending).toBe(true)

			// The app launches, adopts the card and registers its update token.
			expect((await updateToken(device)).status).toBe(200)
			expect(bodies()).toHaveLength(1)
			expect(bodies()[0]).toMatchObject({ event: 'end', 'content-state': { count: 0 } })
			expect(await cardRows()).toHaveLength(0)

			// A token for a NEW activity registered while nobody works is ended too (self-healing),
			// and its token is dropped; the flush never repeats for the first one.
			requests.length = 0
			await updateToken(device)
			expect(bodies()).toHaveLength(1)
			expect(bodies()[0]).toMatchObject({ event: 'end' })
			expect(
				await db
					.select()
					.from(liveActivityTokens)
					.where(eq(liveActivityTokens.workspaceId, workspaceId)),
			).toHaveLength(0)
		} finally {
			fanout.stop()
		}
	})

	it('catches a late update token up with the current state when agents are still working', async () => {
		const s = await newSession(agentA)
		const device = await pushToStart()
		fanout.start()
		try {
			await fanout.handleEvent(lifecycle('session_started', s.id))
			await db
				.update(sessions)
				.set({ currentActivity: 'Sending the email' })
				.where(eq(sessions.id, s.id))
			requests.length = 0
			await updateToken(device)
			expect(bodies()).toHaveLength(1)
			expect(bodies()[0]).toMatchObject({
				event: 'update',
				'content-state': { agents: [{ doing: 'Sending the email' }] },
			})
		} finally {
			fanout.stop()
		}
	})

	it('does nothing for someone with no push-to-start token or who is not a member', async () => {
		const s = await newSession(agentA)
		await fanout.handleEvent(lifecycle('session_started', s.id))
		expect(requests).toHaveLength(0)
		expect(await cardRows()).toHaveLength(0)

		const outsider = (await insertActor(db, { type: 'human' }))?.id as string
		await pushToStart(outsider)
		await fanout.handleEvent(lifecycle('session_started', s.id))
		expect(requests).toHaveLength(0)
	})

	it('never counts another workspace’s agents', async () => {
		const otherWs = (await insertWorkspace(db, human)).id
		await insertSession(db, otherWs, agentB, human, { status: 'running', interactive: false })
		const s = await newSession(agentA)
		await pushToStart()
		await fanout.handleEvent(lifecycle('session_started', s.id))
		expect(bodies()[0]['content-state'].count).toBe(1)
	})

	it('sends nothing to a device that now belongs to someone else', async () => {
		const s = await newSession(agentA)
		const device = await pushToStart()
		await updateToken(device)
		const other = (await insertActor(db, { type: 'human' }))?.id as string
		// Hand the device over without going through the route, so the old
		// actor's token rows survive: the fan-out itself must not trust them.
		await db.update(deviceTokens).set({ actorId: other })
		requests.length = 0

		await fanout.handleEvent(lifecycle('session_started', s.id))
		expect(requests).toHaveLength(0)
	})

	it('removes a token APNs reports as dead', async () => {
		const s = await newSession(agentA)
		await pushToStart()
		const dead = new ApnsSender(db, {
			config: { keyId: 'K', teamId: 'T', privateKey: 'unused', bundleId: 'io.maskin.app' },
			transport: { send: async () => ({ status: 410, body: '{"reason":"Unregistered"}' }) },
		})
		;(dead as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		const f = new LiveActivityFanout(db, new EventEmitter() as unknown as PgNotifyBridge, dead, {
			throttleMs: 0,
		})
		await f.handleEvent(lifecycle('session_started', s.id))
		expect(
			await db
				.select()
				.from(liveActivityTokens)
				.where(eq(liveActivityTokens.kind, 'push_to_start')),
		).toEqual(expect.not.arrayContaining([expect.objectContaining({ actorId: human })]))
	})

	it('keeps the payload under the APNs limit with many agents and long text', async () => {
		const long = 'x'.repeat(200)
		for (let i = 0; i < 12; i++) {
			const a = (await insertActor(db, { type: 'agent', name: `${long}${i}` }))?.id as string
			const conv = (await insertConversation(db, workspaceId, human)).id
			await db.update(conversations).set({ title: long }).where(eq(conversations.id, conv))
			await newSession(a, { currentActivity: long, conversationId: conv })
		}
		await pushToStart()
		await fanout.handleEvent(lifecycle('session_started'))
		expect(Buffer.byteLength(requests[0]?.body as string)).toBeLessThan(4096)
		const state = bodies()[0]['content-state']
		expect(state.count).toBe(12)
		expect(state.agents.length).toBeLessThanOrEqual(6)
	})

	describe('interactive (chat) sessions', () => {
		const closeTurn = (sessionId: string) =>
			db.insert(sessionLogs).values({
				sessionId,
				stream: 'stdout',
				content: '{"type":"result","subtype":"success","result":"done"}',
			})

		it('counts a chat session only while a turn is in flight', async () => {
			const s = await newSession(agentA, { interactive: true })
			await pushToStart()

			// Running between turns: idle, not working.
			await fanout.handleEvent(lifecycle('session_started', s.id))
			expect(requests).toHaveLength(0)

			await fanout.handleTurn({ sessionId: s.id, phase: 'started' } satisfies SessionTurnEvent)
			expect(bodies()).toHaveLength(1)
			expect(bodies()[0]).toMatchObject({ event: 'start', 'content-state': { count: 1 } })

			// The turn closes; the session is still `running`, but nobody is working.
			await closeTurn(s.id)
			await fanout.handleTurn({
				sessionId: s.id,
				phase: 'finished',
				outcome: 'done',
			} satisfies SessionTurnEvent)
			expect(await cardRows()).toHaveLength(1) // end held: no update token yet
			expect((await cardRows())[0]?.endPending).toBe(true)
		})

		it('after a restart, treats a session whose last log row is a result as idle', async () => {
			const s = await newSession(agentA, { interactive: true })
			await closeTurn(s.id)
			await pushToStart()
			await fanout.handleEvent(lifecycle('session_started', s.id))
			expect(requests).toHaveLength(0)
		})

		it('after a restart, treats a session with an open turn in its logs as working', async () => {
			const s = await newSession(agentA, { interactive: true })
			await db.insert(sessionLogs).values({
				sessionId: s.id,
				stream: 'stdout',
				content: '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}',
			})
			await pushToStart()
			await fanout.handleEvent(lifecycle('session_started', s.id))
			expect(bodies()[0]).toMatchObject({ event: 'start', 'content-state': { count: 1 } })
		})
	})
})
