import { SessionError } from '../../services/session-manager'
import { buildCreateSessionBody, buildSession, buildSessionLog } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp } from '../setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Sessions Routes', () => {
	describe('POST /api/sessions', () => {
		it('creates a session and returns 201', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)

			const res = await app.request(
				jsonRequest('POST', '/api/sessions', buildCreateSessionBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(session.id)
			expect(body.status).toBe('running')
		})
	})

	describe('GET /api/sessions', () => {
		it('returns 200 with list of sessions', async () => {
			const s1 = buildSession({ workspaceId: wsId })
			const s2 = buildSession({ workspaceId: wsId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [s1, s2]

			const res = await app.request(jsonGet('/api/sessions', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('GET /api/sessions/:id', () => {
		it('returns 200 when session found', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(session.id)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions/00000000-0000-0000-0000-000000000099', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/sessions/:id/stop', () => {
		it('returns 200 when session stopped', async () => {
			const session = buildSession({ workspaceId: wsId, status: 'completed' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			// First select: auth check, second select: re-fetch after stop
			mockResults.selectQueue = [[session], [session]]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonRequest('POST', '/api/sessions/00000000-0000-0000-0000-000000000099/stop', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when sessionManager throws SessionError with invalid_state', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new SessionError('Session has no container', 'invalid_state'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(body.error.message).toContain('no container')
		})

		it('returns 500 when sessionManager throws an unexpected error', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Docker daemon unreachable'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
		})
	})

	describe('POST /api/sessions/:id/pause', () => {
		it('returns 200 when session paused', async () => {
			const session = buildSession({ workspaceId: wsId, status: 'paused' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], [session]]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonRequest('POST', '/api/sessions/00000000-0000-0000-0000-000000000099/pause', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/sessions/:id/resume', () => {
		it('returns 200 when session resumed', async () => {
			const session = buildSession({ workspaceId: wsId, status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], [session]]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 when sessionManager throws SessionError with invalid_state', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new SessionError('Session is not in paused state', 'invalid_state'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(body.error.message).toContain('not in paused state')
		})

		it('returns 500 when sessionManager throws an unexpected error', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Snapshot download failed'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
		})
	})

	describe('GET /api/sessions/:id/logs', () => {
		it('returns 200 with session logs', async () => {
			const session = buildSession({ workspaceId: wsId })
			const log1 = buildSessionLog({ sessionId: session.id })
			const log2 = buildSessionLog({ sessionId: session.id })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// First select: auth check, second select: logs query
			mockResults.selectQueue = [[session], [log1, log2]]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions/00000000-0000-0000-0000-000000000099/logs', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/sessions/:id/pause error differentiation', () => {
		it('returns 500 when sessionManager throws an unexpected error', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Container exec failed'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
		})
	})

	describe('GET /api/sessions/:id/logs/stream', () => {
		it('returns 400 when x-workspace-id header is missing', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				new Request(
					'http://localhost/api/sessions/00000000-0000-0000-0000-000000000001/logs/stream',
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				new Request(
					'http://localhost/api/sessions/00000000-0000-0000-0000-000000000099/logs/stream',
					{
						headers: { 'x-workspace-id': wsId },
					},
				),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('Session re-fetch null safety', () => {
		it('POST /stop returns 404 when session disappears after stop', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			// Auth check finds session, but re-fetch after stop returns empty
			mockResults.selectQueue = [[session], []]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('POST /pause returns 404 when session disappears after pause', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], []]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('POST /resume returns 404 when session disappears after resume', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], []]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})
})
