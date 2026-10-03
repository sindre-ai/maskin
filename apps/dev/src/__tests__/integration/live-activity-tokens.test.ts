import { EventEmitter } from 'node:events'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, deviceTokens, liveActivityTokens, sessions } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { validationFailureHook } from '../../lib/errors'
import { type ApnsRequest, ApnsSender, type ApnsTransport } from '../../services/apns'
import { LiveActivityFanout } from '../../services/live-activity-push'
import {
	insertActor,
	insertConversation,
	insertNotification,
	insertSession,
	insertWorkspace,
} from '../factories'
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
	let sessionId: string

	beforeEach(async () => {
		human = (await insertActor(db, { type: 'human' }))?.id as string
		stranger = (await insertActor(db, { type: 'human' }))?.id as string
		const agent = (await insertActor(db, { type: 'agent' }))?.id as string
		workspaceId = (await insertWorkspace(db, human)).id
		sessionId = (await insertSession(db, workspaceId, agent, human)).id
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
		expect(rows[0]?.sessionId).toBeNull()
	})

	it('upserts the per-activity update token on (device, session) and writes an audit event', async () => {
		const device = await registerDevice(human)
		const body = { kind: 'update', device_id: device.id, session_id: sessionId }
		const first = await register(
			human,
			{ ...body, token: hex(100) },
			{ 'X-Workspace-Id': workspaceId },
		)
		expect(first.status).toBe(200)
		const newer = hex(100)
		await register(human, { ...body, token: newer }, { 'X-Workspace-Id': workspaceId })

		const rows = await db
			.select()
			.from(liveActivityTokens)
			.where(eq(liveActivityTokens.sessionId, sessionId))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.token).toBe(newer)

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
		expect(JSON.stringify(audit)).not.toContain(newer)
	})

	it('rejects a device that belongs to someone else and a session in a foreign workspace', async () => {
		const device = await registerDevice(human)
		const foreignDevice = await registerDevice(stranger)
		const notMine = await register(stranger, {
			kind: 'push_to_start',
			device_id: device.id,
			token: hex(100),
		})
		expect(notMine.status).toBe(404)

		// stranger owns the device but is not a member of the session's workspace.
		const foreignSession = await register(stranger, {
			kind: 'update',
			device_id: foreignDevice.id,
			session_id: sessionId,
			token: hex(100),
		})
		expect(foreignSession.status).toBe(404)
		expect(await db.select().from(liveActivityTokens)).not.toContainEqual(
			expect.objectContaining({ actorId: stranger }),
		)
	})

	it('validates kind/session_id pairing and hex tokens at the boundary (400) and at the DB (CHECK)', async () => {
		const device = await registerDevice(human)
		expect(
			(await register(human, { kind: 'update', device_id: device.id, token: hex(100) })).status,
		).toBe(400)
		expect(
			(
				await register(human, {
					kind: 'push_to_start',
					device_id: device.id,
					session_id: sessionId,
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
				sessionId: null,
			}),
		).rejects.toThrow()
	})

	it('cascades with the device, the session and the actor', async () => {
		const deviceA = await registerDevice(human)
		const deviceB = await registerDevice(human)
		await register(human, {
			kind: 'update',
			device_id: deviceA.id,
			session_id: sessionId,
			token: hex(100),
		})
		await register(human, { kind: 'push_to_start', device_id: deviceB.id, token: hex(100) })

		await db.delete(deviceTokens).where(eq(deviceTokens.id, deviceB.id))
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.deviceId, deviceB.id)),
		).toHaveLength(0)

		await db.delete(sessions).where(eq(sessions.id, sessionId))
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

describe('LiveActivityFanout lifecycle (real Postgres, fake APNs transport)', () => {
	let human: string
	let agent: string
	let workspaceId: string
	let sessionId: string
	let conversationId: string
	let requests: ApnsRequest[]
	let fanout: LiveActivityFanout

	const transport: ApnsTransport = {
		send: async (req) => {
			requests.push(req)
			return { status: 200, body: '' }
		},
	}
	const bodies = () => requests.map((r) => JSON.parse(r.body).aps)
	const sessionEvent = (action: string) => ({
		workspace_id: workspaceId,
		actor_id: agent,
		action,
		entity_type: 'session',
		entity_id: sessionId,
		event_id: '1',
	})

	beforeEach(async () => {
		requests = []
		human = (await insertActor(db, { type: 'human' }))?.id as string
		agent = (await insertActor(db, { type: 'agent', name: 'Chief of Staff' }))?.id as string
		workspaceId = (await insertWorkspace(db, human)).id
		conversationId = (await insertConversation(db, workspaceId, human)).id
		sessionId = (
			await insertSession(db, workspaceId, agent, human, {
				conversationId,
				status: 'running',
				interactive: true,
				currentActivity: 'Reading the brief',
				startedAt: new Date(),
			})
		).id
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

	async function tokens() {
		const device = await registerDevice(human)
		const app = appAs(human)
		await app.request(
			jsonRequest('POST', '/api/live-activities/tokens', {
				kind: 'push_to_start',
				device_id: device.id,
				token: hex(100),
			}),
		)
		return device
	}

	it('start -> update -> needsYou -> end drives the right pushes and clears update tokens', async () => {
		const device = await tokens()

		await fanout.handleEvent(sessionEvent('session_started'))
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers['apns-push-type']).toBe('liveactivity')
		expect(requests[0]?.headers['apns-topic']).toBe('io.maskin.app.push-type.liveactivity')
		expect(bodies()[0]).toMatchObject({
			event: 'start',
			'attributes-type': 'MaskinTurnAttributes',
			'content-state': {
				sessionId,
				agentName: 'Chief of Staff',
				step: 'Reading the brief',
				status: 'running',
			},
		})

		// The app started the activity and registered its update token.
		await appAs(human).request(
			jsonRequest('POST', '/api/live-activities/tokens', {
				kind: 'update',
				device_id: device.id,
				session_id: sessionId,
				token: hex(100),
			}),
		)
		// A repeat start for a device already showing it is a no-op.
		requests.length = 0
		await fanout.handleEvent(sessionEvent('session_resumed'))
		expect(requests).toHaveLength(0)

		await fanout.handleEvent(sessionEvent('session_updated'))
		expect(bodies()[0]).toMatchObject({ event: 'update', 'content-state': { status: 'running' } })

		requests.length = 0
		const note = await insertNotification(db, workspaceId, agent, {
			type: 'needs_input',
			status: 'pending',
			title: 'Approve the send?',
			targetActorId: human,
			sessionId,
		})
		await fanout.handleEvent({
			workspace_id: workspaceId,
			actor_id: agent,
			action: 'created',
			entity_type: 'notification',
			entity_id: note?.id as string,
			event_id: '2',
		})
		expect(bodies()[0]).toMatchObject({
			event: 'update',
			alert: { title: 'Approve the send?' },
			'content-state': { status: 'needsYou' },
		})

		requests.length = 0
		await fanout.handleEvent(sessionEvent('session_failed'))
		expect(bodies()[0]).toMatchObject({ event: 'end', 'content-state': { status: 'failed' } })
		expect(bodies()[0]['dismissal-date']).toBeGreaterThan(0)
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.kind, 'update')),
		).toEqual(expect.not.arrayContaining([expect.objectContaining({ sessionId })]))
	})

	it('does nothing for a session that is not bound to a conversation', async () => {
		await tokens()
		await db.update(sessions).set({ conversationId: null }).where(eq(sessions.id, sessionId))
		await fanout.handleEvent(sessionEvent('session_started'))
		expect(requests).toHaveLength(0)
	})

	it('removes a token APNs reports as dead', async () => {
		await tokens()
		const dead = new ApnsSender(db, {
			config: { keyId: 'K', teamId: 'T', privateKey: 'unused', bundleId: 'io.maskin.app' },
			transport: { send: async () => ({ status: 410, body: '{"reason":"Unregistered"}' }) },
		})
		;(dead as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		const f = new LiveActivityFanout(db, new EventEmitter() as unknown as PgNotifyBridge, dead)
		await f.handleEvent(sessionEvent('session_started'))
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.actorId, human)),
		).toHaveLength(0)
	})
})
