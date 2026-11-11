import type { Database } from '@maskin/db'
import { notificationPreferences } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertActor } from '../factories'
import { db } from './global-setup'

const { default: emailPickRoutes } = await import('../../routes/email-pick')
const { signEmailPickToken } = await import('../../lib/email-pick-token')

const SECRET = 'integration-test-email-stop-secret-0123456789'
const LOOP_A = '7a7a7a7a-1111-4222-8333-444455556666'
const LOOP_B = '8b8b8b8b-1111-4222-8333-444455556666'

function pickApp() {
	const app = new Hono<{ Variables: { db: Database } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.route('/api/email/pick-dismiss', emailPickRoutes)
	return app
}

const dismissed = async (actorId: string) =>
	(
		await db
			.select({ ids: notificationPreferences.marketplaceDismissedLoopIds })
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
	)[0]?.ids

const form = (token: string) => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: `token=${encodeURIComponent(token)}`,
})

describe('Not useful link (Integration)', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', SECRET)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('opening the link only asks; the form stores the dismissal once, signed out', async () => {
		const actor = (await insertActor(db))?.id as string
		await db
			.insert(notificationPreferences)
			.values({ actorId: actor, marketplacePicksEnabled: true })
		const token = signEmailPickToken(actor, LOOP_A)
		const app = pickApp()

		const page = await app.request(`/api/email/pick-dismiss?token=${token}`)
		expect(page.status).toBe(200)
		expect(await dismissed(actor)).toEqual([])

		expect((await app.request('/api/email/pick-dismiss', form(token))).status).toBe(200)
		expect((await app.request('/api/email/pick-dismiss', form(token))).status).toBe(200)
		expect(await dismissed(actor)).toEqual([LOOP_A])

		// A second flow is added next to the first.
		await app.request('/api/email/pick-dismiss', form(signEmailPickToken(actor, LOOP_B)))
		expect(await dismissed(actor)).toEqual([LOOP_A, LOOP_B])
	})

	it('a changed or foreign link changes nothing', async () => {
		const actor = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: actor })
		const [id, , expiry, sig] = signEmailPickToken(actor, LOOP_A).split('.') as string[]
		const app = pickApp()

		for (const bad of [`${id}.${LOOP_B}.${expiry}.${sig}`, 'nope']) {
			const res = await app.request('/api/email/pick-dismiss', form(bad))
			expect(res.status).toBe(400)
		}
		expect(await dismissed(actor)).toEqual([])
	})

	it('refuses every link when the secret is missing', async () => {
		const actor = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: actor })
		const token = signEmailPickToken(actor, LOOP_A)
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', '')
		const res = await pickApp().request('/api/email/pick-dismiss', form(token))
		expect(res.status).toBe(503)
		expect(await dismissed(actor)).toEqual([])
	})
})
