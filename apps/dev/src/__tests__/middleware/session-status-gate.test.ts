import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { sessionStatusGate } from '../../middleware/session-status-gate'

const VALID_SESSION_ID = '12345678-1234-1234-1234-123456789abc'

interface DbStub {
	status: string | null
	calls: number
}

function createApp(db: DbStub) {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db', {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => {
							db.calls++
							return db.status === null ? [] : [{ status: db.status }]
						},
					}),
				}),
			}),
		})
		await next()
	})
	app.use('*', sessionStatusGate)
	app.post('/test', (c) => c.json({ ok: true }))
	app.get('/test', (c) => c.json({ ok: true }))
	return app
}

describe('sessionStatusGate middleware', () => {
	it('passes through GET requests without touching the DB', async () => {
		const db: DbStub = { status: 'stopped', calls: 0 }
		const app = createApp(db)

		const res = await app.request('/test', {
			method: 'GET',
			headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
		})

		expect(res.status).toBe(200)
		expect(db.calls).toBe(0)
	})

	it('passes through POST without X-Maskin-Session-Id', async () => {
		const db: DbStub = { status: 'running', calls: 0 }
		const app = createApp(db)

		const res = await app.request('/test', { method: 'POST' })

		expect(res.status).toBe(200)
		expect(db.calls).toBe(0)
	})

	it('passes through POST with malformed X-Maskin-Session-Id', async () => {
		const db: DbStub = { status: 'stopped', calls: 0 }
		const app = createApp(db)

		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': 'not-a-uuid' },
		})

		expect(res.status).toBe(200)
		expect(db.calls).toBe(0)
	})

	it('allows POST when session is running', async () => {
		const db: DbStub = { status: 'running', calls: 0 }
		const app = createApp(db)

		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
		})

		expect(res.status).toBe(200)
		expect(db.calls).toBe(1)
	})

	it.each(['stopping', 'stopped', 'completed', 'failed', 'timeout', 'superseded'])(
		'rejects POST with 409 when session status is %s',
		async (status) => {
			const db: DbStub = { status, calls: 0 }
			const app = createApp(db)

			const res = await app.request('/test', {
				method: 'POST',
				headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
			})

			expect(res.status).toBe(409)
			const body = (await res.json()) as { error?: { code?: string; message?: string } }
			expect(body.error?.code).toBe('CONFLICT')
			expect(body.error?.message).toContain(status)
		},
	)

	it('allows the request through if the DB lookup throws', async () => {
		const app = new Hono()
		app.use('*', async (c, next) => {
			c.set('db', {
				select: () => ({
					from: () => ({
						where: () => ({
							limit: async () => {
								throw new Error('db down')
							},
						}),
					}),
				}),
			})
			await next()
		})
		app.use('*', sessionStatusGate)
		app.post('/test', (c) => c.json({ ok: true }))

		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
		})

		expect(res.status).toBe(200)
	})

	it.each(['PUT', 'PATCH', 'DELETE'])('gates %s', async (method) => {
		const db: DbStub = { status: 'stopped', calls: 0 }
		const app = createApp(db)
		// Register handler for the method
		app.on(method, '/test', (c) => c.json({ ok: true }))

		const res = await app.request('/test', {
			method,
			headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
		})

		expect(res.status).toBe(409)
	})

	it('does not log the request through when status comes back as something unrecognized', async () => {
		const db: DbStub = { status: 'unknown-state', calls: 0 }
		const app = createApp(db)
		const res = await app.request('/test', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
		})
		expect(res.status).toBe(200)
		expect(db.calls).toBe(1)
	})

	it('logger warns silently — does not throw', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const app = new Hono()
		app.use('*', async (c, next) => {
			c.set('db', {
				select: () => ({
					from: () => ({
						where: () => ({
							limit: async () => {
								throw new Error('db down')
							},
						}),
					}),
				}),
			})
			await next()
		})
		app.use('*', sessionStatusGate)
		app.post('/test', (c) => c.json({ ok: true }))

		await app.request('/test', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': VALID_SESSION_ID },
		})

		warnSpy.mockRestore()
	})
})
