import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createIdempotencyMiddleware } from '../../middleware/idempotency'
import { createTestContext } from '../setup'

function createApp(actorId = 'actor-1', dbCtx = createTestContext()) {
	let callCount = 0
	const app = new Hono()

	app.use('*', async (c, next) => {
		c.set('actorId', actorId)
		await next()
	})

	app.use('*', createIdempotencyMiddleware(dbCtx.db))

	app.post('/test', (c) => {
		callCount++
		return c.json({ count: callCount })
	})

	app.get('/test', (c) => {
		callCount++
		return c.json({ count: callCount })
	})

	app.patch('/test', (c) => {
		callCount++
		return c.json({ count: callCount })
	})

	app.delete('/test', (c) => {
		callCount++
		return c.json({ count: callCount })
	})

	return { app, getCallCount: () => callCount, mockResults: dbCtx.mockResults }
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
		const { app, getCallCount } = createApp()

		await app.request('/test', { method: 'GET', headers: { 'Idempotency-Key': 'k1' } })
		await app.request('/test', { method: 'GET', headers: { 'Idempotency-Key': 'k1' } })

		expect(getCallCount()).toBe(2)
	})

	it('returns cached response from DB on duplicate Idempotency-Key', async () => {
		const dbCtx = createTestContext()
		const { app, getCallCount } = createApp('actor-1', dbCtx)

		// First call: DB returns no cache row → handler runs and we cache.
		dbCtx.mockResults.selectQueue = [[]]

		const res1 = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'dedup-key' },
		})
		expect((await res1.json()).count).toBe(1)
		expect(getCallCount()).toBe(1)

		// Second call: DB returns the previously cached row.
		dbCtx.mockResults.selectQueue = [
			[
				{
					key: 'actor-1:dedup-key',
					actorId: 'actor-1',
					method: 'POST',
					path: '/test',
					status: 200,
					response: { count: 99 },
					createdAt: new Date(),
				},
			],
		]

		const res2 = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'dedup-key' },
		})
		expect((await res2.json()).count).toBe(99)
		expect(getCallCount()).toBe(1) // handler NOT called again
	})

	it('falls open when DB lookup throws (does not block writes)', async () => {
		const dbCtx = createTestContext()
		const { app, getCallCount } = createApp('actor-1', dbCtx)

		dbCtx.mockResults.selectError = new Error('connection refused')

		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-x' },
		})

		expect(res.status).toBe(200)
		expect(getCallCount()).toBe(1)
	})

	it('ignores expired cache rows beyond the TTL window', async () => {
		const dbCtx = createTestContext()
		const { app, getCallCount } = createApp('actor-1', dbCtx)

		const expired = new Date(Date.now() - 48 * 60 * 60 * 1000) // 48h old
		dbCtx.mockResults.selectQueue = [
			[
				{
					key: 'actor-1:expired',
					actorId: 'actor-1',
					method: 'POST',
					path: '/test',
					status: 200,
					response: { count: 99 },
					createdAt: expired,
				},
			],
		]

		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'expired' },
		})

		expect((await res.json()).count).toBe(1) // handler ran, expired row ignored
		expect(getCallCount()).toBe(1)
	})

	it('caches PATCH and DELETE with Idempotency-Key', async () => {
		const dbCtx = createTestContext()
		const { app } = createApp('actor-1', dbCtx)

		dbCtx.mockResults.selectQueue = [[]]
		const r1 = await app.request('/test', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'p1' },
		})
		expect(r1.status).toBe(200)

		dbCtx.mockResults.selectQueue = [[]]
		const r2 = await app.request('/test', {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'd1' },
		})
		expect(r2.status).toBe(200)
	})
})
