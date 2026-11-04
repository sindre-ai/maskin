import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, webPushSubscriptions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { validationFailureHook } from '../../lib/errors'
import { WebPushSender, type WebPushTransport } from '../../services/web-push'
import { insertActor } from '../factories'
import { jsonRequest } from '../helpers'
import { db } from './global-setup'

const { default: webPushRoutes, MAX_SUBSCRIPTIONS_PER_ACTOR } = await import(
	'../../routes/web-push'
)

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

// The calling actor is chosen per request so the test can play two users sharing one browser.
function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/web-push', webPushRoutes)
	return app
}

const keys = {
	p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u',
	auth: 'tBHItJI5svbpez7KI4CCXg',
}
const subscribeBody = (endpoint: string) => ({ endpoint, keys, user_agent: 'Chrome' })

describe('web_push_subscriptions', () => {
	let endpoint: string
	let actorA: string
	let actorB: string

	beforeEach(async () => {
		endpoint = `https://fcm.googleapis.com/send/${crypto.randomUUID()}`
		actorA = (await insertActor(db))?.id as string
		actorB = (await insertActor(db))?.id as string
	})

	const rowsFor = (e: string) =>
		db.select().from(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, e))

	it('registers a subscription and is idempotent on re-subscribe (one row, same id)', async () => {
		const app = appAs(actorA)
		const first = await app.request(
			jsonRequest('POST', '/api/web-push/subscriptions', subscribeBody(endpoint)),
		)
		const second = await app.request(
			jsonRequest('POST', '/api/web-push/subscriptions', subscribeBody(endpoint)),
		)
		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect((await first.json()).id).toBe((await second.json()).id)
		const rows = await rowsFor(endpoint)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(actorA)
		expect(rows[0]?.p256dh).toBe(keys.p256dh)
	})

	it('moves the subscription to the new actor when another actor re-subscribes the endpoint', async () => {
		await appAs(actorA).request(
			jsonRequest('POST', '/api/web-push/subscriptions', subscribeBody(endpoint)),
		)
		const res = await appAs(actorB).request(
			jsonRequest('POST', '/api/web-push/subscriptions', subscribeBody(endpoint)),
		)
		expect(res.status).toBe(200)
		const rows = await rowsFor(endpoint)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(actorB)
	})

	it('enforces UNIQUE(endpoint)', async () => {
		const base = { actorId: actorA, endpoint, p256dh: keys.p256dh, auth: keys.auth }
		await db.insert(webPushSubscriptions).values(base)
		await expect(db.insert(webPushSubscriptions).values(base)).rejects.toThrow()
	})

	it('cascades subscription rows when the actor is deleted', async () => {
		await appAs(actorA).request(
			jsonRequest('POST', '/api/web-push/subscriptions', subscribeBody(endpoint)),
		)
		await db.delete(actors).where(eq(actors.id, actorA))
		expect(await rowsFor(endpoint)).toHaveLength(0)
	})

	it('only lets the owner delete a subscription; others get 404', async () => {
		const created = await appAs(actorA).request(
			jsonRequest('POST', '/api/web-push/subscriptions', subscribeBody(endpoint)),
		)
		const { id } = await created.json()

		const stranger = await appAs(actorB).request(
			jsonRequest('DELETE', `/api/web-push/subscriptions/${id}`),
		)
		expect(stranger.status).toBe(404)
		expect(await rowsFor(endpoint)).toHaveLength(1)

		const owner = await appAs(actorA).request(
			jsonRequest('DELETE', `/api/web-push/subscriptions/${id}`),
		)
		expect(owner.status).toBe(200)
		expect(await rowsFor(endpoint)).toHaveLength(0)
	})

	it('keeps at most MAX_SUBSCRIPTIONS_PER_ACTOR, dropping the least recently seen', async () => {
		const app = appAs(actorA)
		const oldest = `https://fcm.googleapis.com/send/${crypto.randomUUID()}`
		await db.insert(webPushSubscriptions).values({
			actorId: actorA,
			endpoint: oldest,
			p256dh: keys.p256dh,
			auth: keys.auth,
			lastSeenAt: new Date(Date.now() - 86_400_000),
		})
		for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_ACTOR; i++) {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/web-push/subscriptions',
					subscribeBody(`https://fcm.googleapis.com/send/${crypto.randomUUID()}`),
				),
			)
			expect(res.status).toBe(200)
		}
		const mine = await db
			.select()
			.from(webPushSubscriptions)
			.where(eq(webPushSubscriptions.actorId, actorA))
		expect(mine).toHaveLength(MAX_SUBSCRIPTIONS_PER_ACTOR)
		expect(await rowsFor(oldest)).toHaveLength(0)
	})

	it('WebPushSender prunes a subscription the push service reports gone (410) and keeps live ones', async () => {
		const gone = `https://fcm.googleapis.com/gone/${crypto.randomUUID()}`
		const live = `https://fcm.googleapis.com/live/${crypto.randomUUID()}`
		for (const e of [gone, live]) {
			await db
				.insert(webPushSubscriptions)
				.values({ actorId: actorA, endpoint: e, p256dh: keys.p256dh, auth: keys.auth })
		}
		const transport: WebPushTransport = {
			send: async (_c, target) => ({ status: target.endpoint === gone ? 410 : 201 }),
		}
		const sender = new WebPushSender(db, {
			config: { publicKey: 'p', privateKey: 'k', subject: 'mailto:ops@example.com' },
			transport,
		})
		await sender.sendToActor(actorA, {
			title: 'Hi',
			workspaceId: 'ws',
			notificationId: crypto.randomUUID(),
		})
		expect(await rowsFor(gone)).toHaveLength(0)
		expect(await rowsFor(live)).toHaveLength(1)
	})
})
