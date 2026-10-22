import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, deviceTokens, events, liveActivityTokens } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { validationFailureHook } from '../../lib/errors'
import { type ApnsRequest, ApnsSender } from '../../services/apns'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: devicesRoutes, resetUnregisterLimiterForTests } = await import(
	'../../routes/devices'
)

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

// Same routes, but the calling actor is chosen per request so the test can
// play two different users registering the same physical device.
function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/devices', devicesRoutes)
	return app
}

const body = (token: string, environment = 'sandbox') => ({
	platform: 'ios',
	apns_token: token,
	environment,
	app_version: '1.0',
})

describe('device_tokens', () => {
	let token: string
	let actorA: string
	let actorB: string

	beforeEach(async () => {
		token = [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')
		actorA = (await insertActor(db))?.id as string
		actorB = (await insertActor(db))?.id as string
	})

	it('registers a device and is idempotent on re-register (one row, last_seen_at advances)', async () => {
		const app = appAs(actorA)
		const first = await app.request(jsonRequest('POST', '/api/devices', body(token)))
		expect(first.status).toBe(200)
		const second = await app.request(jsonRequest('POST', '/api/devices', body(token)))
		expect(second.status).toBe(200)

		const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(actorA)
		expect(rows[0]?.lastSeenAt.getTime()).toBeGreaterThanOrEqual(rows[0]?.createdAt.getTime() ?? 0)
	})

	it('moves the token to the new actor when another actor re-registers it', async () => {
		await appAs(actorA).request(jsonRequest('POST', '/api/devices', body(token)))
		const res = await appAs(actorB).request(jsonRequest('POST', '/api/devices', body(token)))
		expect(res.status).toBe(200)

		const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(actorB)
	})

	it('enforces UNIQUE(apns_token, environment) but allows the same token in another environment', async () => {
		const base = { actorId: actorA, platform: 'ios', apnsToken: token, environment: 'sandbox' }
		await db.insert(deviceTokens).values(base)
		await expect(db.insert(deviceTokens).values(base)).rejects.toThrow()
		await db.insert(deviceTokens).values({ ...base, environment: 'production' })
		const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token))
		expect(rows).toHaveLength(2)
	})

	it('cascades device rows when the actor is deleted', async () => {
		await appAs(actorA).request(jsonRequest('POST', '/api/devices', body(token)))
		await db.delete(actors).where(eq(actors.id, actorA))
		const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token))
		expect(rows).toHaveLength(0)
	})

	it('only lets the owner delete a device (by token), others get 404', async () => {
		await appAs(actorA).request(jsonRequest('POST', '/api/devices', body(token)))

		const stranger = await appAs(actorB).request(jsonRequest('DELETE', `/api/devices/${token}`))
		expect(stranger.status).toBe(404)
		expect(
			await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token)),
		).toHaveLength(1)

		const owner = await appAs(actorA).request(jsonRequest('DELETE', `/api/devices/${token}`))
		expect(owner.status).toBe(200)
		expect(
			await db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token)),
		).toHaveLength(0)
	})
})

// The route a signed-out phone calls. The harness has no auth middleware, so this app sets no
// actor at all: the handler must not need one. That the real app admits the path without an API
// key is covered in app-factory-device-unregister.test.ts.
function anonymousApp() {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.route('/api/devices', devicesRoutes)
	return app
}

describe('POST /api/devices/unregister', () => {
	const SECRET = 's'.repeat(43)
	const OTHER_SECRET = 'o'.repeat(43)
	let token: string
	let actorA: string
	let actorB: string

	const registerAs = (actorId: string, secret?: string) =>
		appAs(actorId).request(
			jsonRequest('POST', '/api/devices', {
				...body(token),
				...(secret ? { unregister_secret: secret } : {}),
			}),
		)
	const unregister = (payload: Record<string, unknown>) =>
		anonymousApp().request(jsonRequest('POST', '/api/devices/unregister', payload))
	const attempt = (secret = SECRET) =>
		unregister({ apns_token: token, environment: 'sandbox', unregister_secret: secret })
	const rows = () => db.select().from(deviceTokens).where(eq(deviceTokens.apnsToken, token))

	beforeEach(async () => {
		resetUnregisterLimiterForTests()
		token = [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')
		actorA = (await insertActor(db))?.id as string
		actorB = (await insertActor(db))?.id as string
	})

	it('stores only a hash of the secret, never the secret', async () => {
		await registerAs(actorA, SECRET)
		const [row] = await rows()
		expect(row?.unregisterSecretHash).toMatch(/^[0-9a-f]{64}$/)
		expect(row?.unregisterSecretHash).not.toContain(SECRET)
	})

	it('removes the device, its Live Activity tokens and the push target when the secret matches', async () => {
		const reg = await registerAs(actorA, SECRET)
		const { id } = (await reg.json()) as { id: string }
		await db.insert(liveActivityTokens).values({
			actorId: actorA,
			deviceId: id,
			kind: 'push_to_start',
			token: 'ab'.repeat(20),
		})
		const sent: ApnsRequest[] = []
		const sender = new ApnsSender(db, {
			config: { keyId: 'K', teamId: 'T', privateKey: 'unused', bundleId: 'io.maskin.app' },
			transport: {
				send: async (req) => {
					sent.push(req)
					return { status: 200, body: '' }
				},
			},
		})
		;(sender as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		const push = () =>
			sender.sendToActor(actorA, { title: 'Decision', workspaceId: actorA, notificationId: 'n1' })
		await push()
		expect(sent).toHaveLength(1)

		const res = await attempt()
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })
		expect(await rows()).toHaveLength(0)
		expect(
			await db.select().from(liveActivityTokens).where(eq(liveActivityTokens.deviceId, id)),
		).toHaveLength(0)

		// sendToActor reads device_tokens, so it no longer has anything to send to.
		await push()
		expect(sent).toHaveLength(1)
	})

	it('records the same deleted audit event as the authenticated delete, for the owner', async () => {
		const ws = await insertWorkspace(db, actorA)
		const reg = await appAs(actorA).request(
			new Request('http://localhost/api/devices', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': ws.id },
				body: JSON.stringify({ ...body(token), unregister_secret: SECRET }),
			}),
		)
		const { id } = (await reg.json()) as { id: string }

		await attempt()

		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, id), eq(events.action, 'deleted')))
		expect(audit).toHaveLength(1)
		expect(audit[0]?.actorId).toBe(actorA)
		expect(audit[0]?.entityType).toBe('device')
	})

	it('answers a wrong secret exactly like an unknown token and deletes nothing', async () => {
		await registerAs(actorA, SECRET)

		const wrong = await unregister({
			apns_token: token,
			environment: 'sandbox',
			unregister_secret: OTHER_SECRET,
		})
		const unknown = await unregister({
			apns_token: 'c'.repeat(64),
			environment: 'sandbox',
			unregister_secret: SECRET,
		})
		const wrongEnv = await unregister({
			apns_token: token,
			environment: 'production',
			unregister_secret: SECRET,
		})

		for (const res of [wrong, unknown, wrongEnv]) {
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ deleted: false })
		}
		expect(await rows()).toHaveLength(1)
	})

	it('deletes nothing for a device registered without a secret', async () => {
		await registerAs(actorA)

		const res = await attempt()
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: false })
		expect(await rows()).toHaveLength(1)
	})

	it('replaces the hash when the token registers again, so the old secret deletes nothing', async () => {
		await registerAs(actorA, SECRET)
		await registerAs(actorB, OTHER_SECRET)
		expect((await rows())[0]?.actorId).toBe(actorB)

		const old = await attempt()
		expect(await old.json()).toEqual({ deleted: false })
		expect(await rows()).toHaveLength(1)

		const current = await unregister({
			apns_token: token,
			environment: 'sandbox',
			unregister_secret: OTHER_SECRET,
		})
		expect(await current.json()).toEqual({ deleted: true })
		expect(await rows()).toHaveLength(0)
	})

	it('clears the secret when the token registers again without one', async () => {
		await registerAs(actorA, SECRET)
		await registerAs(actorB)
		expect((await rows())[0]?.unregisterSecretHash).toBeNull()
	})

	it('returns 200 deleted false when called a second time', async () => {
		await registerAs(actorA, SECRET)
		const payload = { apns_token: token, environment: 'sandbox', unregister_secret: SECRET }
		expect(await (await unregister(payload)).json()).toEqual({ deleted: true })
		const again = await unregister(payload)
		expect(again.status).toBe(200)
		expect(await again.json()).toEqual({ deleted: false })
	})

	it('matches the token case-insensitively, like registration', async () => {
		await registerAs(actorA, SECRET)
		const res = await unregister({
			apns_token: token.toUpperCase(),
			environment: 'sandbox',
			unregister_secret: SECRET,
		})
		expect(await res.json()).toEqual({ deleted: true })
	})

	it('rejects a malformed secret or a missing field with 400', async () => {
		for (const unregister_secret of ['short', `${'x'.repeat(31)}!`, 'x'.repeat(129)]) {
			const res = await unregister({ apns_token: token, environment: 'sandbox', unregister_secret })
			expect(res.status).toBe(400)
		}
		const missing = await unregister({ apns_token: token, environment: 'sandbox' })
		expect(missing.status).toBe(400)
		const register = await appAs(actorA).request(
			jsonRequest('POST', '/api/devices', { ...body(token), unregister_secret: 'short' }),
		)
		expect(register.status).toBe(400)
	})

	it('answers 429 with Retry-After once a caller passes the limit', async () => {
		const payload = { apns_token: token, environment: 'sandbox', unregister_secret: SECRET }
		for (let i = 0; i < 20; i++) expect((await unregister(payload)).status).toBe(200)
		const res = await unregister(payload)
		expect(res.status).toBe(429)
		expect(res.headers.get('Retry-After')).toBeTruthy()
	})
})
