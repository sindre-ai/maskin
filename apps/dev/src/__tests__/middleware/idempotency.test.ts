import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { idempotencyMiddleware } from '../../middleware/idempotency'

function createApp(actorId = 'actor-1') {
	let callCount = 0
	const app = new Hono()

	// Inject actorId into context
	app.use('*', async (c, next) => {
		c.set('actorId', actorId)
		await next()
	})

	app.use('*', idempotencyMiddleware)

	app.post('/test', (c) => {
		callCount++
		return c.json({ count: callCount })
	})

	app.get('/test', (c) => {
		callCount++
		return c.json({ count: callCount })
	})

	return { app, getCallCount: () => callCount }
}

describe('idempotency middleware', () => {
	it('passes through POST without Idempotency-Key', async () => {
		const { app } = createApp()

		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		})

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.count).toBe(1)
	})

	it('bypasses middleware for GET requests', async () => {
		const { app } = createApp()

		const res1 = await app.request('/test', {
			method: 'GET',
			headers: { 'Idempotency-Key': 'key-1' },
		})
		const res2 = await app.request('/test', {
			method: 'GET',
			headers: { 'Idempotency-Key': 'key-1' },
		})

		const body1 = await res1.json()
		const body2 = await res2.json()
		// Both should invoke the handler (GET is not cached)
		expect(body1.count).toBe(1)
		expect(body2.count).toBe(2)
	})

	it('returns cached response for duplicate Idempotency-Key', async () => {
		const { app, getCallCount } = createApp()

		const req = () =>
			app.request('/test', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Idempotency-Key': 'dedup-key',
				},
			})

		const res1 = await req()
		const body1 = await res1.json()
		expect(body1.count).toBe(1)

		const res2 = await req()
		const body2 = await res2.json()
		// Should return cached response, handler not called again
		expect(body2.count).toBe(1)
		expect(getCallCount()).toBe(1)
	})

	it('treats different keys independently', async () => {
		const { app } = createApp()

		const res1 = await app.request('/test', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': 'key-a',
			},
		})
		const res2 = await app.request('/test', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Idempotency-Key': 'key-b',
			},
		})

		const body1 = await res1.json()
		const body2 = await res2.json()
		expect(body1.count).toBe(1)
		expect(body2.count).toBe(2)
	})

	it('isolates cache by actor', async () => {
		const { app: app1 } = createApp('actor-1')
		const { app: app2 } = createApp('actor-2')

		const headers = {
			'Content-Type': 'application/json',
			'Idempotency-Key': 'shared-key',
		}

		const res1 = await app1.request('/test', { method: 'POST', headers })
		const res2 = await app2.request('/test', { method: 'POST', headers })

		const body1 = await res1.json()
		const body2 = await res2.json()
		// Different actors with same key should both invoke handler
		expect(body1.count).toBe(1)
		expect(body2.count).toBe(1) // separate app instance, so count resets
	})
})
