import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, deviceTokens } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { validationFailureHook } from '../../lib/errors'
import { insertActor } from '../factories'
import { jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: devicesRoutes } = await import('../../routes/devices')

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
