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

describe('Agent Server E2E: Trigger-fired Sessions', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	it('creates a session with trigger_id from trigger runner', async () => {
		const { app, sessionManager } = createApp()
		const triggerId = 'trigger-abc-123'
		const session = buildSession({
			status: 'pending',
			triggerId,
		})
		vi.mocked(sessionManager.createSession).mockResolvedValue(session)

		const res = await app.request('/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				workspace_id: session.workspaceId,
				actor_id: session.actorId,
				action_prompt: 'Handle event: task status changed to in_progress',
				created_by: 'trigger-runner',
				trigger_id: triggerId,
				auto_start: true,
			}),
		})

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.triggerId || body.trigger_id).toBeTruthy()

		expect(sessionManager.createSession).toHaveBeenCalledWith(
			session.workspaceId,
			expect.objectContaining({
				triggerId,
				autoStart: true,
				actionPrompt: expect.stringContaining('Handle event'),
			}),
		)
	})

	it('creates a trigger-fired session and verifies it can be stopped', async () => {
		const { app, sessionManager, mockResults } = createApp()
		const triggerId = 'trigger-xyz-789'
		const session = buildSession({ status: 'running', triggerId })
		vi.mocked(sessionManager.createSession).mockResolvedValue(session)

		// Create session via trigger
		const createRes = await app.request('/sessions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				workspace_id: session.workspaceId,
				actor_id: session.actorId,
				action_prompt: 'Triggered action',
				created_by: 'trigger-runner',
				trigger_id: triggerId,
			}),
		})
		expect(createRes.status).toBe(201)
		const created = await createRes.json()

		// Stop the trigger-fired session
		const stoppedSession = { ...session, status: 'completed', result: { exit_code: 0 } }
		mockResults.select = [stoppedSession]

		const stopRes = await app.request(`/sessions/${created.id}/stop`, {
			method: 'POST',
		})
		expect(stopRes.status).toBe(200)
		expect(sessionManager.stopSession).toHaveBeenCalledWith(created.id)
	})

	it('supports creating multiple trigger-fired sessions concurrently', async () => {
		const { app, sessionManager } = createApp()

		const sessions = Array.from({ length: 3 }, (_, i) =>
			buildSession({ status: 'pending', triggerId: `trigger-${i}` }),
		)

		let callCount = 0
		vi.mocked(sessionManager.createSession).mockImplementation(() => {
			return Promise.resolve(sessions[callCount++])
		})

		const results = await Promise.all(
			sessions.map((session, i) =>
				app.request('/sessions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						workspace_id: session.workspaceId,
						actor_id: session.actorId,
						action_prompt: `Trigger action ${i}`,
						created_by: 'trigger-runner',
						trigger_id: `trigger-${i}`,
					}),
				}),
			),
		)

		for (const res of results) {
			expect(res.status).toBe(201)
		}
		expect(sessionManager.createSession).toHaveBeenCalledTimes(3)
	})
})
