import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import sessionRoutes from '../../routes/sessions'
import { buildSession } from '../factories'
import { createMockSessionManager, createTestContext } from '../setup'

type Env = {
	Variables: {
		db: ReturnType<typeof createTestContext>['db']
		sessionManager: ReturnType<typeof createMockSessionManager>
	}
}

function createApp() {
	const { db, mockResults } = createTestContext()
	const sessionManager = createMockSessionManager()

	const app = new Hono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db as never)
		c.set('sessionManager', sessionManager as never)
		return next()
	})
	app.route('/sessions', sessionRoutes)

	return { app, db, mockResults, sessionManager }
}

const validBody = {
	type: 'user',
	message: { role: 'user', content: 'Say hello' },
}

describe('Agent Server E2E: POST /sessions/:id/input', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('forwards the payload to sessionManager.writeInput when running + interactive', async () => {
		const { app, sessionManager, mockResults } = createApp()
		const session = buildSession({ status: 'running', interactive: true })
		mockResults.select = [session]

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(validBody),
		})

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ ok: true })
		expect(sessionManager.writeInput).toHaveBeenCalledWith(session.id, {
			type: 'user',
			message: { role: 'user', content: 'Say hello' },
		})
	})

	it('returns 404 when the session does not exist', async () => {
		const { app, sessionManager, mockResults } = createApp()
		mockResults.select = []

		const res = await app.request('/sessions/missing-id/input', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(validBody),
		})

		expect(res.status).toBe(404)
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('returns 409 when the session is not interactive', async () => {
		const { app, sessionManager, mockResults } = createApp()
		const session = buildSession({ status: 'running', interactive: false })
		mockResults.select = [session]

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(validBody),
		})

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error).toMatch(/not interactive/)
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('returns 409 when the session is not running', async () => {
		const { app, sessionManager, mockResults } = createApp()
		const session = buildSession({ status: 'paused', interactive: true })
		mockResults.select = [session]

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(validBody),
		})

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error).toMatch(/not running/)
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('returns 400 when sessionManager.writeInput rejects', async () => {
		const { app, sessionManager, mockResults } = createApp()
		const session = buildSession({ status: 'running', interactive: true })
		mockResults.select = [session]
		vi.mocked(sessionManager.writeInput).mockRejectedValueOnce(new Error('stdin closed'))

		const res = await app.request(`/sessions/${session.id}/input`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(validBody),
		})

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error).toBe('stdin closed')
	})

	it('returns 400 on malformed payload (missing message.content)', async () => {
		const { app, sessionManager } = createApp()

		const res = await app.request('/sessions/some-id/input', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'user', message: { role: 'user' } }),
		})

		expect(res.status).toBe(400)
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})

	it('returns 400 on invalid JSON body', async () => {
		const { app, sessionManager } = createApp()

		const res = await app.request('/sessions/some-id/input', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not-json',
		})

		expect(res.status).toBe(400)
		expect(sessionManager.writeInput).not.toHaveBeenCalled()
	})
})
