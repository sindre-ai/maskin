import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { sessionWriteGate } from '../../middleware/session-write-gate'
import { createTestContext } from '../setup'

const VALID_ID = '00000000-0000-0000-0000-000000000001'

function buildApp(sessionRow: { status: string } | null) {
	const { db, mockResults } = createTestContext()
	if (sessionRow) {
		mockResults.select = [sessionRow]
	}
	const app = new Hono()
	app.use('*', sessionWriteGate(db))
	app.post('/api/events', (c) => c.json({ ok: true }))
	return app
}

describe('sessionWriteGate', () => {
	it('passes through when no X-Maskin-Session-Id header is present', async () => {
		const app = buildApp(null)
		const res = await app.request('/api/events', { method: 'POST' })
		expect(res.status).toBe(200)
	})

	it('passes through when header is a non-UUID string', async () => {
		const app = buildApp(null)
		const res = await app.request('/api/events', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': 'not-a-uuid' },
		})
		expect(res.status).toBe(200)
	})

	it('passes through when the session is unknown', async () => {
		const app = buildApp(null)
		const res = await app.request('/api/events', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': VALID_ID },
		})
		expect(res.status).toBe(200)
	})

	it('passes through when the session is still running', async () => {
		const app = buildApp({ status: 'running' })
		const res = await app.request('/api/events', {
			method: 'POST',
			headers: { 'X-Maskin-Session-Id': VALID_ID },
		})
		expect(res.status).toBe(200)
	})

	it.each(['stopping', 'stopped', 'completed', 'failed', 'timeout', 'superseded'])(
		'rejects with 409 when the session is %s',
		async (status) => {
			const app = buildApp({ status })
			const res = await app.request('/api/events', {
				method: 'POST',
				headers: { 'X-Maskin-Session-Id': VALID_ID },
			})
			expect(res.status).toBe(409)
			const body = (await res.json()) as { error: { code: string; message: string } }
			expect(body.error.code).toBe('CONFLICT')
			expect(body.error.message).toContain(status)
		},
	)
})
