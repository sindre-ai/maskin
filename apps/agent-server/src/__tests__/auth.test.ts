import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { bearerAuth } from '../lib/auth'

const SECRET = 'shared-bearer-test-secret-thirty-two-chars'

function buildTestApp(secret: string = SECRET): Hono {
	const app = new Hono()
	app.use('/protected/*', bearerAuth({ expectedSecret: secret }))
	app.get('/protected/ping', (c) => c.json({ ok: true }))
	app.get('/open', (c) => c.json({ ok: true }))
	return app
}

describe('bearerAuth middleware', () => {
	it('passes the call through when Authorization matches the expected secret', async () => {
		const app = buildTestApp()
		const res = await app.request('/protected/ping', {
			headers: { authorization: `Bearer ${SECRET}` },
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
	})

	it('rejects with 401 when the Authorization header is missing', async () => {
		const app = buildTestApp()
		const res = await app.request('/protected/ping')
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({ error: 'unauthorized' })
	})

	it('rejects with 401 when the bearer token is wrong', async () => {
		const app = buildTestApp()
		const res = await app.request('/protected/ping', {
			headers: { authorization: 'Bearer not-the-real-secret' },
		})
		expect(res.status).toBe(401)
	})

	it('rejects with 401 when the scheme is missing or wrong', async () => {
		const app = buildTestApp()
		const noScheme = await app.request('/protected/ping', {
			headers: { authorization: SECRET },
		})
		expect(noScheme.status).toBe(401)

		const wrongScheme = await app.request('/protected/ping', {
			headers: { authorization: `Token ${SECRET}` },
		})
		expect(wrongScheme.status).toBe(401)
	})

	it('rejects with 401 when the bearer token shares a prefix but differs in length', async () => {
		const app = buildTestApp()
		const truncated = await app.request('/protected/ping', {
			headers: { authorization: `Bearer ${SECRET.slice(0, -1)}` },
		})
		expect(truncated.status).toBe(401)

		const longer = await app.request('/protected/ping', {
			headers: { authorization: `Bearer ${SECRET}x` },
		})
		expect(longer.status).toBe(401)
	})

	it('does not apply to routes outside the mount path', async () => {
		const app = buildTestApp()
		const res = await app.request('/open')
		expect(res.status).toBe(200)
	})
})
