import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { SHED_RETRY_AFTER_S, dbLoadShed } from '../../middleware/db-load-shed'

function buildApp(load: { count: number }, limit = 100, onShed = vi.fn()) {
	const app = new Hono()
	app.use('/api/*', dbLoadShed(load, limit, onShed))
	app.all('/api/*', (c) => c.json({ ok: true }))
	return { app, onShed }
}

describe('dbLoadShed', () => {
	it('lets reads through while the backlog is within the limit', async () => {
		const { app, onShed } = buildApp({ count: 100 })
		expect((await app.request('/api/objects')).status).toBe(200)
		expect(onShed).not.toHaveBeenCalled()
	})

	it('refuses reads with a 503 and Retry-After once the backlog passes the limit', async () => {
		const { app, onShed } = buildApp({ count: 101 })
		const res = await app.request('/api/objects')
		expect(res.status).toBe(503)
		expect(res.headers.get('Retry-After')).toBe(String(SHED_RETRY_AFTER_S))
		expect(onShed).toHaveBeenCalledTimes(1)
	})

	it('still lets writes through', async () => {
		const { app } = buildApp({ count: 5_000 })
		expect((await app.request('/api/objects', { method: 'POST' })).status).toBe(200)
		expect((await app.request('/api/objects/1', { method: 'PATCH' })).status).toBe(200)
	})

	it.each([
		'/api/health',
		'/api/webhooks/resend/abc',
		'/api/internal/agent-servers/sessions/1/logs',
		'/api/events',
		'/api/sessions/1/logs/stream',
	])('never refuses %s', async (path) => {
		const { app, onShed } = buildApp({ count: 5_000 })
		expect((await app.request(path)).status).toBe(200)
		expect(onShed).not.toHaveBeenCalled()
	})

	it('reads the backlog on every request, so it recovers when the backlog clears', async () => {
		const load = { count: 5_000 }
		const { app } = buildApp(load)
		expect((await app.request('/api/objects')).status).toBe(503)
		load.count = 3
		expect((await app.request('/api/objects')).status).toBe(200)
	})
})
