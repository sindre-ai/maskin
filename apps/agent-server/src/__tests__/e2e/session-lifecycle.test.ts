import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authMiddleware } from '../../middleware/auth'
import sessionRoutes from '../../routes/sessions'
import { buildSession, buildSessionLog } from '../factories'
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

function createAuthApp() {
	const { db, mockResults } = createTestContext()
	const sessionManager = createMockSessionManager()

	const app = new Hono<Env>()

	app.get('/health', (c) => c.json({ status: 'ok' }))
	app.use('*', authMiddleware)
	app.use('*', async (c, next) => {
		c.set('db', db as never)
		c.set('sessionManager', sessionManager as never)
		return next()
	})
	app.route('/sessions', sessionRoutes)

	return { app, db, mockResults, sessionManager }
}

describe('Agent Server E2E: Session Lifecycle', () => {
	beforeEach(() => {
		vi.restoreAllMocks()
	})

	describe('Auth middleware', () => {
		it('allows health endpoint without auth', async () => {
			vi.stubEnv('AGENT_SERVER_SECRET', 'test-secret')
			const { app } = createAuthApp()

			const res = await app.request('/health')
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.status).toBe('ok')
		})

		it('rejects requests without X-Agent-Server-Secret header', async () => {
			vi.stubEnv('AGENT_SERVER_SECRET', 'test-secret')
			const { app } = createAuthApp()

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			expect(res.status).toBe(401)
			const body = await res.json()
			expect(body.error).toBe('Unauthorized')
		})

		it('rejects requests with wrong secret', async () => {
			vi.stubEnv('AGENT_SERVER_SECRET', 'test-secret')
			const { app } = createAuthApp()

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': 'wrong-secret',
				},
				body: JSON.stringify({}),
			})
			expect(res.status).toBe(401)
		})

		it('allows requests with correct secret', async () => {
			vi.stubEnv('AGENT_SERVER_SECRET', 'test-secret')
			const { app, sessionManager } = createAuthApp()
			const session = buildSession({ status: 'pending' })
			vi.mocked(sessionManager.createSession).mockResolvedValue(session)

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': 'test-secret',
				},
				body: JSON.stringify({
					workspace_id: session.workspaceId,
					actor_id: session.actorId,
					action_prompt: 'Test prompt',
					created_by: 'test-creator',
				}),
			})
			expect(res.status).toBe(201)
		})
	})

	describe('POST /sessions — create session', () => {
		it('creates a session and returns 201', async () => {
			const { app, sessionManager } = createApp()
			const session = buildSession({ status: 'pending' })
			vi.mocked(sessionManager.createSession).mockResolvedValue(session)

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace_id: session.workspaceId,
					actor_id: session.actorId,
					action_prompt: 'Implement feature X',
					created_by: 'test-creator',
					auto_start: true,
				}),
			})

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(session.id)
			expect(sessionManager.createSession).toHaveBeenCalledWith(
				session.workspaceId,
				expect.objectContaining({
					actorId: session.actorId,
					actionPrompt: 'Implement feature X',
					createdBy: 'test-creator',
					autoStart: true,
				}),
			)
		})

		it('returns 400 for missing required fields', async () => {
			const { app } = createApp()

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ workspace_id: 'ws-1' }),
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toContain('Missing required fields')
		})

		it('returns 500 when session manager throws', async () => {
			const { app, sessionManager } = createApp()
			vi.mocked(sessionManager.createSession).mockRejectedValue(
				new Error('Container creation failed'),
			)

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace_id: 'ws-1',
					actor_id: 'actor-1',
					action_prompt: 'Do something',
					created_by: 'creator-1',
				}),
			})

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error).toBe('Container creation failed')
		})

		it('passes trigger_id when provided', async () => {
			const { app, sessionManager } = createApp()
			const session = buildSession({ status: 'pending', triggerId: 'trigger-1' })
			vi.mocked(sessionManager.createSession).mockResolvedValue(session)

			const res = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace_id: session.workspaceId,
					actor_id: session.actorId,
					action_prompt: 'Handle trigger event',
					created_by: 'trigger-runner',
					trigger_id: 'trigger-1',
				}),
			})

			expect(res.status).toBe(201)
			expect(sessionManager.createSession).toHaveBeenCalledWith(
				session.workspaceId,
				expect.objectContaining({ triggerId: 'trigger-1' }),
			)
		})
	})

	describe('POST /sessions/:id/stop — stop session', () => {
		it('stops a running session', async () => {
			const { app, sessionManager, mockResults } = createApp()
			const session = buildSession({ status: 'completed' })
			mockResults.select = [session]

			const res = await app.request(`/sessions/${session.id}/stop`, {
				method: 'POST',
			})

			expect(res.status).toBe(200)
			expect(sessionManager.stopSession).toHaveBeenCalledWith(session.id)
			const body = await res.json()
			expect(body.id).toBe(session.id)
		})

		it('returns 400 when session cannot be stopped', async () => {
			const { app, sessionManager } = createApp()
			vi.mocked(sessionManager.stopSession).mockRejectedValue(
				new Error('Session not found or has no container'),
			)

			const res = await app.request('/sessions/nonexistent/stop', {
				method: 'POST',
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toContain('Session not found or has no container')
		})
	})

	describe('POST /sessions/:id/pause — pause session', () => {
		it('pauses a running session and returns updated state', async () => {
			const { app, sessionManager, mockResults } = createApp()
			const session = buildSession({ status: 'paused', snapshotPath: 'snapshots/test.tar.gz' })
			mockResults.select = [session]

			const res = await app.request(`/sessions/${session.id}/pause`, {
				method: 'POST',
			})

			expect(res.status).toBe(200)
			expect(sessionManager.pauseSession).toHaveBeenCalledWith(session.id)
			const body = await res.json()
			expect(body.id).toBe(session.id)
		})

		it('returns 400 when session is not in running state', async () => {
			const { app, sessionManager } = createApp()
			vi.mocked(sessionManager.pauseSession).mockRejectedValue(
				new Error('Session not in running state'),
			)

			const res = await app.request('/sessions/test-id/pause', {
				method: 'POST',
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toContain('not in running state')
		})
	})

	describe('POST /sessions/:id/resume — resume session', () => {
		it('resumes a paused session', async () => {
			const { app, sessionManager, mockResults } = createApp()
			const session = buildSession({ status: 'running' })
			mockResults.select = [session]

			const res = await app.request(`/sessions/${session.id}/resume`, {
				method: 'POST',
			})

			expect(res.status).toBe(200)
			expect(sessionManager.resumeSession).toHaveBeenCalledWith(session.id)
			const body = await res.json()
			expect(body.id).toBe(session.id)
		})

		it('returns 400 when session is not paused', async () => {
			const { app, sessionManager } = createApp()
			vi.mocked(sessionManager.resumeSession).mockRejectedValue(
				new Error('Session not in paused state or no snapshot'),
			)

			const res = await app.request('/sessions/test-id/resume', {
				method: 'POST',
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error).toContain('not in paused state')
		})
	})

	describe('GET /sessions/:id/status — session status', () => {
		it('returns session status for a running session', async () => {
			const { app, mockResults } = createApp()
			const session = buildSession({
				status: 'running',
				startedAt: new Date('2026-04-11T10:00:00Z'),
				result: null,
			})
			mockResults.select = [session]

			const res = await app.request(`/sessions/${session.id}/status`)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(session.id)
			expect(body.status).toBe('running')
			expect(body.started_at).toBeTruthy()
			expect(body.completed_at).toBeNull()
		})

		it('returns session status for a completed session', async () => {
			const { app, mockResults } = createApp()
			const session = buildSession({
				status: 'completed',
				result: { exit_code: 0 },
				completedAt: new Date('2026-04-11T10:05:00Z'),
			})
			mockResults.select = [session]

			const res = await app.request(`/sessions/${session.id}/status`)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.status).toBe('completed')
			expect(body.result).toEqual({ exit_code: 0 })
		})

		it('returns 404 for nonexistent session', async () => {
			const { app, mockResults } = createApp()
			mockResults.select = []

			const res = await app.request('/sessions/nonexistent/status')

			expect(res.status).toBe(404)
		})
	})

	describe('Full lifecycle: create → stop', () => {
		it('creates a session then stops it', async () => {
			const { app, sessionManager, mockResults } = createApp()
			const session = buildSession({ status: 'pending' })
			vi.mocked(sessionManager.createSession).mockResolvedValue(session)

			// Step 1: Create session
			const createRes = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace_id: session.workspaceId,
					actor_id: session.actorId,
					action_prompt: 'Run E2E test',
					created_by: 'e2e-test',
				}),
			})
			expect(createRes.status).toBe(201)
			const created = await createRes.json()

			// Step 2: Check status
			const runningSession = { ...session, status: 'running' }
			mockResults.select = [runningSession]
			const statusRes = await app.request(`/sessions/${created.id}/status`)
			expect(statusRes.status).toBe(200)
			const statusBody = await statusRes.json()
			expect(statusBody.status).toBe('running')

			// Step 3: Stop session
			const stoppedSession = { ...session, status: 'completed', result: { exit_code: 0 } }
			mockResults.select = [stoppedSession]
			const stopRes = await app.request(`/sessions/${created.id}/stop`, {
				method: 'POST',
			})
			expect(stopRes.status).toBe(200)
			expect(sessionManager.stopSession).toHaveBeenCalledWith(created.id)
		})
	})

	describe('Full lifecycle: create → pause → resume', () => {
		it('creates, pauses, and resumes a session', async () => {
			const { app, sessionManager, mockResults } = createApp()
			const session = buildSession({ status: 'pending' })
			vi.mocked(sessionManager.createSession).mockResolvedValue(session)

			// Step 1: Create
			const createRes = await app.request('/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					workspace_id: session.workspaceId,
					actor_id: session.actorId,
					action_prompt: 'Run pause/resume test',
					created_by: 'e2e-test',
				}),
			})
			expect(createRes.status).toBe(201)
			const created = await createRes.json()

			// Step 2: Pause
			const pausedSession = {
				...session,
				status: 'paused',
				snapshotPath: 'snapshots/test.tar.gz',
				containerId: null,
			}
			mockResults.select = [pausedSession]
			const pauseRes = await app.request(`/sessions/${created.id}/pause`, {
				method: 'POST',
			})
			expect(pauseRes.status).toBe(200)
			expect(sessionManager.pauseSession).toHaveBeenCalledWith(created.id)

			// Step 3: Resume
			const resumedSession = { ...session, status: 'running', snapshotPath: null }
			mockResults.select = [resumedSession]
			const resumeRes = await app.request(`/sessions/${created.id}/resume`, {
				method: 'POST',
			})
			expect(resumeRes.status).toBe(200)
			expect(sessionManager.resumeSession).toHaveBeenCalledWith(created.id)
		})
	})
})
