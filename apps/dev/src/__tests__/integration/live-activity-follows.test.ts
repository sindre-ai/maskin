import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	conversations,
	deviceTokens,
	liveActivityFollows,
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

async function registerDevice(actorId: string) {
	const res = await appAs(actorId).request(
		jsonRequest('POST', '/api/devices', {
			platform: 'ios',
			apns_token: hex(),
			environment: 'sandbox',
		}),
	)
	expect(res.status).toBe(200)
	return (await res.json()) as { id: string }
}

const follow = (actorId: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
	appAs(actorId).request(jsonRequest('POST', '/api/live-activities/follows', body, headers))

const unfollow = (actorId: string, sessionId: string, deviceId: string) =>
	appAs(actorId).request(
		jsonRequest('DELETE', `/api/live-activities/follows/${sessionId}?device_id=${deviceId}`),
	)

describe('live_activity_follows routes (real Postgres)', () => {
	let human: string
	let stranger: string
	let agent: string
	let workspaceId: string
	let sessionId: string
	let headers: Record<string, string>

	beforeEach(async () => {
		human = (await insertActor(db, { type: 'human' }))?.id as string
		stranger = (await insertActor(db, { type: 'human' }))?.id as string
		agent = (await insertActor(db, { type: 'agent', name: 'Developer' }))?.id as string
		workspaceId = (await insertWorkspace(db, human)).id
		sessionId = (await insertSession(db, workspaceId, agent, human, { status: 'running' }))?.id
		headers = { 'X-Workspace-Id': workspaceId }
	})

	it('registers the card token for a run, replaces it on repeat, and audits without the token', async () => {
		const device = await registerDevice(human)
		const first = hex(100)
		const res = await follow(
			human,
			{ device_id: device.id, session_id: sessionId, token: first },
			headers,
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { id: string; session_id: string; workspace_id: string }
		expect(body).toMatchObject({ session_id: sessionId, workspace_id: workspaceId })

		const second = hex(100)
		await follow(human, { device_id: device.id, session_id: sessionId, token: second }, headers)
		const rows = await db
			.select()
			.from(liveActivityFollows)
			.where(eq(liveActivityFollows.sessionId, sessionId))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.token).toBe(second)

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.entityType, 'live_activity_follow'), eq(events.entityId, body.id)))
		expect(audit.map((e) => e.action).sort()).toEqual(['created', 'updated'])
		expect(JSON.stringify(audit)).not.toContain(first)
		expect(JSON.stringify(audit)).not.toContain(second)
	})

	it('rejects a foreign device, another workspace’s run, a missing header and a non-member', async () => {
		const mine = await registerDevice(human)
		const theirs = await registerDevice(stranger)
		const token = hex(100)

		expect(
			(await follow(human, { device_id: theirs.id, session_id: sessionId, token }, headers)).status,
		).toBe(404)

		const otherWorkspace = (await insertWorkspace(db, human)).id
		const otherRun = (await insertSession(db, otherWorkspace, agent, human, { status: 'running' }))
			?.id
		expect(
			(await follow(human, { device_id: mine.id, session_id: otherRun, token }, headers)).status,
		).toBe(404)

		expect((await follow(human, { device_id: mine.id, session_id: sessionId, token })).status).toBe(
			400,
		)

		expect(
			(
				await follow(
					stranger,
					{ device_id: theirs.id, session_id: sessionId, token },
					{ 'X-Workspace-Id': workspaceId },
				)
			).status,
		).toBe(404)

		expect(
			(
				await follow(
					human,
					{ device_id: mine.id, session_id: sessionId, token: 'not-hex-xyz-not-hex-xyz' },
					headers,
				)
			).status,
		).toBe(400)
		expect(await db.select().from(liveActivityFollows)).toHaveLength(0)
	})

	it('stops following one device only, and a repeat is a harmless no-op', async () => {
		const a = await registerDevice(human)
		const b = await registerDevice(human)
		await follow(human, { device_id: a.id, session_id: sessionId, token: hex(100) }, headers)
		await follow(human, { device_id: b.id, session_id: sessionId, token: hex(100) }, headers)

		const first = await unfollow(human, sessionId, a.id)
		expect(first.status).toBe(200)
		expect(await first.json()).toEqual({ deleted: true })
		const again = await unfollow(human, sessionId, a.id)
		expect(await again.json()).toEqual({ deleted: false })

		const left = await db.select().from(liveActivityFollows)
		expect(left.map((r) => r.deviceId)).toEqual([b.id])
		// Someone else cannot stop the person's follow.
		expect(await (await unfollow(stranger, sessionId, b.id)).json()).toEqual({ deleted: false })
		expect(await db.select().from(liveActivityFollows)).toHaveLength(1)
	})

	it('goes away with the run', async () => {
		const device = await registerDevice(human)
		await follow(human, { device_id: device.id, session_id: sessionId, token: hex(100) }, headers)
		await db.delete(sessions).where(eq(sessions.id, sessionId))
		expect(await db.select().from(liveActivityFollows)).toHaveLength(0)
	})
})

describe('Following an agent Live Activity (real Postgres, fake APNs transport)', () => {
	let human: string
	let agent: string
	let workspaceId: string
	let requests: ApnsRequest[]
	let fanout: LiveActivityFanout
	let headers: Record<string, string>

	const transport: ApnsTransport = {
		send: async (req) => {
			requests.push(req)
			return { status: 200, body: '' }
		},
	}
	const bodies = () => requests.map((r) => JSON.parse(r.body).aps)
	const lifecycle = (action: string, entityId: string) => ({
		workspace_id: workspaceId,
		actor_id: agent,
		action,
		entity_type: 'session',
		entity_id: entityId,
		event_id: '1',
	})
	const makeSender = (t: ApnsTransport) => {
		const sender = new ApnsSender(db, {
			config: { keyId: 'K', teamId: 'T', privateKey: 'unused', bundleId: 'io.maskin.app' },
			transport: t,
		})
		// The JWT is irrelevant to the fake transport; skip real signing.
		;(sender as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		return sender
	}
	const newSession = (over: Record<string, unknown> = {}) =>
		insertSession(db, workspaceId, agent, human, {
			status: 'running',
			interactive: false,
			currentActivity: 'Reading the brief',
			startedAt: new Date(),
			...over,
		})
	const startFollowing = async (sessionId: string) => {
		const device = await registerDevice(human)
		const token = hex(100)
		const res = await follow(human, { device_id: device.id, session_id: sessionId, token }, headers)
		expect(res.status).toBe(200)
		return { device, token }
	}
	const followRows = () =>
		db.select().from(liveActivityFollows).where(eq(liveActivityFollows.workspaceId, workspaceId))

	beforeEach(async () => {
		requests = []
		human = (await insertActor(db, { type: 'human' }))?.id as string
		agent = (await insertActor(db, { type: 'agent', name: 'Developer' }))?.id as string
		workspaceId = (await insertWorkspace(db, human)).id
		headers = { 'X-Workspace-Id': workspaceId }
		fanout = new LiveActivityFanout(
			db,
			new EventEmitter() as unknown as PgNotifyBridge,
			makeSender(transport),
			{
				throttleMs: 0,
			},
		)
		fanout.start()
	})

	afterEach(() => {
		fanout.stop()
	})

	it('pushes the latest step to the card when the person follows, shaped like FollowActivityState', async () => {
		const conversationId = (await insertConversation(db, workspaceId, human)).id
		await db
			.update(conversations)
			.set({ title: 'Webhook dedup fix' })
			.where(eq(conversations.id, conversationId))
		const s = await newSession({ conversationId, currentActivity: 'Running the booking tests' })
		const { token } = await startFollowing(s.id)

		expect(requests).toHaveLength(1)
		expect(requests[0]?.token).toBe(token)
		expect(requests[0]?.headers['apns-topic']).toBe('io.maskin.app.push-type.liveactivity')
		expect(requests[0]?.headers['apns-priority']).toBe('5')
		const aps = bodies()[0]
		expect(aps.event).toBe('update')
		expect(aps['attributes-type']).toBeUndefined()
		expect(aps.alert).toBeUndefined()
		expect(aps['content-state']).toEqual({
			agentName: 'Developer',
			topic: 'Webhook dedup fix',
			doing: 'Running the booking tests',
			startedAt: expect.any(Number),
			phase: 'following',
		})
		expect(aps['stale-date']).toBe(aps.timestamp + 15 * 60)
	})

	it('sends an update when the step changes and nothing when it does not', async () => {
		const s = await newSession()
		await startFollowing(s.id)
		requests.length = 0

		await fanout.handleEvent(lifecycle('session_updated', s.id))
		expect(requests).toHaveLength(0)

		await db
			.update(sessions)
			.set({ currentActivity: 'Sending the email' })
			.where(eq(sessions.id, s.id))
		await fanout.handleEvent(lifecycle('session_updated', s.id))
		expect(bodies()).toHaveLength(1)
		expect(bodies()[0]['content-state']).toMatchObject({
			doing: 'Sending the email',
			phase: 'following',
		})
	})

	it('sends the finished card when the run ends, then forgets the follow', async () => {
		const s = await newSession()
		const { token } = await startFollowing(s.id)
		requests.length = 0

		await db
			.update(sessions)
			.set({ status: 'completed', currentActivity: 'Opened the pull request' })
			.where(eq(sessions.id, s.id))
		await fanout.handleEvent(lifecycle('session_completed', s.id))

		expect(bodies()).toHaveLength(1)
		expect(requests[0]?.token).toBe(token)
		expect(requests[0]?.headers['apns-priority']).toBe('10')
		expect(bodies()[0]).toMatchObject({
			event: 'end',
			'content-state': {
				agentName: 'Developer',
				doing: 'Opened the pull request',
				phase: 'finished',
			},
		})
		// The finished card lingers 15 minutes so Review is one tap away.
		expect(bodies()[0]['dismissal-date']).toBe(bodies()[0].timestamp + 15 * 60)
		expect(await followRows()).toHaveLength(0)

		requests.length = 0
		await fanout.handleEvent(lifecycle('session_updated', s.id))
		expect(requests).toHaveLength(0)
	})

	it('finishes a follow registered after the run already ended', async () => {
		const s = await newSession({ status: 'completed' })
		await startFollowing(s.id)
		expect(bodies()).toHaveLength(1)
		expect(bodies()[0]).toMatchObject({ event: 'end', 'content-state': { phase: 'finished' } })
		expect(await followRows()).toHaveLength(0)
	})

	it('stops pushing once the person stops following', async () => {
		const s = await newSession()
		const { device } = await startFollowing(s.id)
		await unfollow(human, s.id, device.id)
		requests.length = 0

		await db.update(sessions).set({ currentActivity: 'Another step' }).where(eq(sessions.id, s.id))
		await fanout.handleEvent(lifecycle('session_updated', s.id))
		expect(requests).toHaveLength(0)
	})

	it('never pushes another workspace’s run to the card, and skips a device that changed hands', async () => {
		const s = await newSession()
		const { device } = await startFollowing(s.id)
		requests.length = 0

		const elsewhere = (await insertWorkspace(db, human)).id
		const other = await insertSession(db, elsewhere, agent, human, { status: 'running' })
		await fanout.handleEvent({
			...lifecycle('session_started', other?.id),
			workspace_id: elsewhere,
		})
		expect(requests).toHaveLength(0)

		const newOwner = (await insertActor(db, { type: 'human' }))?.id as string
		await db.update(deviceTokens).set({ actorId: newOwner }).where(eq(deviceTokens.id, device.id))
		await db.update(sessions).set({ currentActivity: 'Next' }).where(eq(sessions.id, s.id))
		await fanout.handleEvent(lifecycle('session_updated', s.id))
		expect(requests).toHaveLength(0)
	})

	it('removes a follow whose card token APNs reports as dead', async () => {
		fanout.stop()
		const dead = makeSender({
			send: async () => ({ status: 410, body: '{"reason":"Unregistered"}' }),
		})
		fanout = new LiveActivityFanout(db, new EventEmitter() as unknown as PgNotifyBridge, dead, {
			throttleMs: 0,
		})
		fanout.start()
		const s = await newSession()
		await startFollowing(s.id)
		expect(await followRows()).toHaveLength(0)
	})

	it('follows a chat run per turn: working while a turn is open, finished when it closes', async () => {
		const s = await newSession({ interactive: true })
		await fanout.handleTurn({ sessionId: s.id, phase: 'started' } satisfies SessionTurnEvent)
		await startFollowing(s.id)
		expect(bodies()).toHaveLength(1)
		expect(bodies()[0]).toMatchObject({ event: 'update', 'content-state': { phase: 'following' } })

		requests.length = 0
		await db.insert(sessionLogs).values({
			sessionId: s.id,
			stream: 'stdout',
			content: '{"type":"result","subtype":"success","result":"done"}',
		})
		await fanout.handleTurn({
			sessionId: s.id,
			phase: 'finished',
			outcome: 'done',
		} satisfies SessionTurnEvent)
		expect(bodies()).toHaveLength(1)
		expect(bodies()[0]).toMatchObject({ event: 'end', 'content-state': { phase: 'finished' } })
		expect(await followRows()).toHaveLength(0)
	})
})
