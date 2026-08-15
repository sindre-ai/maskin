import { apnsDeviceTokens } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: apnsTokensRoutes } = await import('../../routes/apns-tokens')

function createApp() {
	return createIntegrationApp({ path: '/api/apns-tokens', module: apnsTokensRoutes })
}

// 64-char lowercase hex — one physical APNs device token shape.
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

describe('APNs Tokens Integration — PATCH /api/apns-tokens', () => {
	it('inserts a new row on first PATCH', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: TOKEN_A,
				environment: 'sandbox',
			}),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.token).toBe(TOKEN_A)
		expect(body.environment).toBe('sandbox')

		const rows = await db.select().from(apnsDeviceTokens).where(eq(apnsDeviceTokens.token, TOKEN_A))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(getTestActorId())
	})

	it('is idempotent: same token PATCHed twice yields one row with a bumped updated_at', async () => {
		const app = createApp()
		const first = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: TOKEN_A,
				environment: 'sandbox',
			}),
		)
		expect(first.status).toBe(200)
		const firstBody = await first.json()

		// Small delay so updated_at is measurably different.
		await new Promise((r) => setTimeout(r, 20))

		const second = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: TOKEN_A,
				environment: 'sandbox',
			}),
		)
		expect(second.status).toBe(200)
		const secondBody = await second.json()

		const rows = await db.select().from(apnsDeviceTokens).where(eq(apnsDeviceTokens.token, TOKEN_A))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe(firstBody.id)
		expect(new Date(secondBody.updated_at).getTime()).toBeGreaterThan(
			new Date(firstBody.updated_at).getTime(),
		)
	})

	it('re-assigns actor_id via ON CONFLICT DO UPDATE (device signs in as new actor)', async () => {
		// Same physical device signs out of actor A, back in as actor B. The
		// upsert must move the token to B so pushes stop targeting A on that
		// device. The route handler runs the same `onConflictDoUpdate` — this
		// exercises the DB semantic under the same shape without needing to
		// swap the middleware-set actor context mid-test.
		const first = await insertActor(db, { type: 'human', name: 'First Signer' })
		const second = await insertActor(db, { type: 'human', name: 'Second Signer' })

		await db
			.insert(apnsDeviceTokens)
			.values({ actorId: first.id, token: TOKEN_A, environment: 'sandbox' })

		await db
			.insert(apnsDeviceTokens)
			.values({ actorId: second.id, token: TOKEN_A, environment: 'production' })
			.onConflictDoUpdate({
				target: apnsDeviceTokens.token,
				set: { actorId: second.id, environment: 'production', updatedAt: new Date() },
			})

		const rows = await db.select().from(apnsDeviceTokens).where(eq(apnsDeviceTokens.token, TOKEN_A))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.actorId).toBe(second.id)
		expect(rows[0]?.environment).toBe('production')
	})

	it('rejects a non-hex token with 400 (input validation at the boundary)', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: 'not-hex-@@@',
				environment: 'sandbox',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('rejects an unknown environment with 400', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: TOKEN_A,
				environment: 'staging',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('normalises token casing so an upper-case retry does not split rows', async () => {
		const app = createApp()
		const upper = TOKEN_B.toUpperCase()

		const first = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: upper,
				environment: 'sandbox',
			}),
		)
		expect(first.status).toBe(200)

		const second = await app.request(
			jsonRequest('PATCH', '/api/apns-tokens', {
				token: TOKEN_B,
				environment: 'sandbox',
			}),
		)
		expect(second.status).toBe(200)

		const rows = await db.select().from(apnsDeviceTokens)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.token).toBe(TOKEN_B)
	})

	it('drops the row when the owning actor is deleted (FK cascade)', async () => {
		const app = createApp()
		const throwaway = await insertActor(db, { type: 'human', name: 'To Delete' })
		await db
			.insert(apnsDeviceTokens)
			.values({ actorId: throwaway.id, token: TOKEN_A, environment: 'sandbox' })

		await sql`DELETE FROM actors WHERE id = ${throwaway.id}`

		const rows = await db.select().from(apnsDeviceTokens)
		expect(rows).toHaveLength(0)

		// Sanity: control app request still parses (unrelated to the delete).
		expect(app).toBeDefined()
	})
})
