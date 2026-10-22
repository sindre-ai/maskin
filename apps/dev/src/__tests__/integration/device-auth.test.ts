import { OpenAPIHono } from '@hono/zod-openapi'
import { actors, deviceAuthCodes } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { hashCode } from '../../lib/device-auth-codes'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: deviceAuthRoutes, resetDeviceAuthLimitersForTests } = await import(
	'../../routes/device-auth'
)

// Device sign-in runs against real Postgres: what matters is the single-use UPDATE, the hashes at
// rest, and expiry, none of which a mocked DB can show.
describe('device sign-in (integration)', () => {
	let app: ReturnType<typeof createIntegrationApp>

	beforeEach(() => {
		resetDeviceAuthLimitersForTests()
		app = createIntegrationApp({ path: '/api/device-auth', module: deviceAuthRoutes })
	})

	async function start(
		body: Record<string, unknown> = { client: 'tvos', device_name: 'Living Room' },
	) {
		const res = await app.request(jsonRequest('POST', '/api/device-auth/start', body))
		expect(res.status).toBe(201)
		return (await res.json()) as {
			device_code: string
			user_code: string
			verification_uri: string
			verification_uri_complete: string
			expires_in: number
			interval: number
		}
	}

	async function poll(deviceCode: string) {
		const res = await app.request(
			jsonRequest('POST', '/api/device-auth/token', { device_code: deviceCode }),
		)
		expect(res.status).toBe(200)
		return (await res.json()) as {
			status: string
			interval?: number
			actor?: { id: string; api_key: string }
		}
	}

	it('hands the session over once, after a person approves, and never again', async () => {
		const started = await start()
		expect(started.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/)
		expect(started.verification_uri_complete).toContain(`code=${started.user_code}`)

		const pending = await poll(started.device_code)
		expect(pending.status).toBe('pending')
		expect(pending.actor).toBeUndefined()

		const approve = await app.request(
			jsonRequest('POST', '/api/device-auth/approve', {
				user_code: started.user_code.toLowerCase(),
			}),
		)
		expect(approve.status).toBe(200)

		const approved = await poll(started.device_code)
		expect(approved.status).toBe('approved')
		expect(approved.actor?.id).toBe(getTestActorId())
		const [actor] = await db.select().from(actors).where(eq(actors.id, getTestActorId()))
		expect(approved.actor?.api_key).toBe(actor?.apiKey)

		// Spent: the same device code never yields the session twice.
		expect((await poll(started.device_code)).status).toBe('expired')
	})

	it('stores only hashes of the codes', async () => {
		const started = await start()
		const rows = await db.select().from(deviceAuthCodes)
		const row = rows.find((r) => r.deviceCodeHash === hashCode(started.device_code))
		expect(row).toBeDefined()
		const flat = JSON.stringify(row)
		expect(flat).not.toContain(started.device_code)
		expect(flat).not.toContain(started.user_code.replace('-', ''))
	})

	it('a refused code ends as denied and cannot be approved afterwards', async () => {
		const started = await start()
		const deny = await app.request(
			jsonRequest('POST', '/api/device-auth/deny', { user_code: started.user_code }),
		)
		expect(deny.status).toBe(200)
		expect((await poll(started.device_code)).status).toBe('denied')

		const lateApprove = await app.request(
			jsonRequest('POST', '/api/device-auth/approve', { user_code: started.user_code }),
		)
		expect(lateApprove.status).toBe(404)
		expect((await poll(started.device_code)).status).toBe('denied')
	})

	it('an expired code can be neither previewed nor approved, and polls as expired', async () => {
		const started = await start()
		await db
			.update(deviceAuthCodes)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(deviceAuthCodes.deviceCodeHash, hashCode(started.device_code)))

		const preview = await app.request(
			jsonGet(`/api/device-auth/preview?user_code=${started.user_code}`),
		)
		expect(preview.status).toBe(404)
		const approve = await app.request(
			jsonRequest('POST', '/api/device-auth/approve', { user_code: started.user_code }),
		)
		expect(approve.status).toBe(404)
		expect((await poll(started.device_code)).status).toBe('expired')
	})

	it('an unknown device code looks exactly like an expired one', async () => {
		expect((await poll('not-a-real-device-code')).status).toBe('expired')
	})

	it('preview names the asking device, and junk codes are not found', async () => {
		const started = await start({ client: 'tvos', device_name: 'Living Room' })
		const ok = await app.request(jsonGet(`/api/device-auth/preview?user_code=${started.user_code}`))
		expect(ok.status).toBe(200)
		expect(await ok.json()).toMatchObject({ client: 'tvos', device_name: 'Living Room' })

		const junk = await app.request(jsonGet('/api/device-auth/preview?user_code=AAAA-0000'))
		expect(junk.status).toBe(404)
	})

	it('only a person can approve: an agent key is refused', async () => {
		const started = await start()
		const agentApp = new OpenAPIHono()
		agentApp.use('*', async (c, next) => {
			// biome-ignore lint/suspicious/noExplicitAny: minimal context for the agent case
			const ctx = c as any
			ctx.set('db', db)
			ctx.set('actorId', getTestActorId())
			ctx.set('actorType', 'agent')
			await next()
		})
		agentApp.route('/api/device-auth', deviceAuthRoutes)

		const res = await agentApp.request(
			jsonRequest('POST', '/api/device-auth/approve', { user_code: started.user_code }),
		)
		expect(res.status).toBe(403)
		expect((await poll(started.device_code)).status).toBe('pending')
	})

	it('rate limits starting codes per caller', async () => {
		for (let i = 0; i < 10; i++) await start()
		const res = await app.request(jsonRequest('POST', '/api/device-auth/start', { client: 'tvos' }))
		expect(res.status).toBe(429)
		expect(res.headers.get('Retry-After')).toBeTruthy()
	})

	it('refuses a client it does not know', async () => {
		const res = await app.request(
			jsonRequest('POST', '/api/device-auth/start', { client: 'toaster' }),
		)
		expect(res.status).toBe(400)
	})
})
