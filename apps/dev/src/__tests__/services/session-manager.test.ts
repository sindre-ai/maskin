import { vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { SessionManager } from '../../services/session-manager'
import { buildSession } from '../factories'
import { createTestContext } from '../setup'

function createManager() {
	const ctx = createTestContext()
	const manager = new SessionManager(ctx.db, 'http://agent-server:3001', 'test-secret')
	return { manager, ...ctx }
}

function mockJsonResponse(status: number, body: unknown) {
	mockFetch.mockResolvedValueOnce({
		ok: status >= 200 && status < 300,
		status,
		statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
		json: vi.fn().mockResolvedValue(body),
		body: null,
	})
}

function mockSseResponse() {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				read: vi
					.fn()
					.mockResolvedValueOnce({
						done: false,
						value: new TextEncoder().encode('event:done\ndata:\n\n'),
					})
					.mockResolvedValue({ done: true, value: undefined }),
			}),
		},
	})
}

describe('SessionManager', () => {
	beforeEach(() => {
		mockFetch.mockReset()
	})

	describe('createSession()', () => {
		it('creates a session by delegating to agent-server', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'pending' })

			// POST /sessions
			mockJsonResponse(200, { id: session.id })
			// DB read returns the session
			mockResults.select = [session]

			const result = await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Do the thing',
				createdBy: 'creator-1',
				autoStart: false,
			})

			expect(result.id).toBe(session.id)
			expect(mockFetch).toHaveBeenCalledWith(
				'http://agent-server:3001/sessions',
				expect.objectContaining({
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Agent-Server-Secret': 'test-secret',
					},
				}),
			)
		})

		it('subscribes to logs when autoStart is true', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			// POST /sessions
			mockJsonResponse(200, { id: session.id })
			// SSE subscription for logs
			mockSseResponse()
			// DB read
			mockResults.select = [session]

			const result = await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Do the thing',
				createdBy: 'creator-1',
				autoStart: true,
			})

			expect(result.id).toBe(session.id)
			// 2 fetch calls: POST + SSE subscribe
			expect(mockFetch).toHaveBeenCalledTimes(2)

			await manager.stop()
		})

		it('throws when agent-server returns error', async () => {
			const { manager } = createManager()
			mockJsonResponse(500, { error: 'Internal server error' })

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Do the thing',
					createdBy: 'creator-1',
					autoStart: false,
				}),
			).rejects.toThrow('Internal server error')
		})

		it('throws when session not found in database after creation', async () => {
			const { manager, mockResults } = createManager()
			mockJsonResponse(200, { id: 'new-session-id' })
			mockResults.select = []

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Do the thing',
					createdBy: 'creator-1',
					autoStart: false,
				}),
			).rejects.toThrow('Session created on agent-server but not found in database')
		})
	})

	describe('stopSession()', () => {
		it('sends stop request to agent-server', async () => {
			const { manager } = createManager()
			mockJsonResponse(200, { ok: true })

			await manager.stopSession('session-123')

			expect(mockFetch).toHaveBeenCalledWith(
				'http://agent-server:3001/sessions/session-123/stop',
				expect.objectContaining({ method: 'POST' }),
			)
		})

		it('throws when agent-server returns error', async () => {
			const { manager } = createManager()
			mockJsonResponse(404, { error: 'Session not found or has no container' })

			await expect(manager.stopSession('nonexistent')).rejects.toThrow(
				'Session not found or has no container',
			)
		})
	})

	describe('pauseSession()', () => {
		it('sends pause request to agent-server', async () => {
			const { manager } = createManager()
			mockJsonResponse(200, { ok: true })

			await manager.pauseSession('session-123')

			expect(mockFetch).toHaveBeenCalledWith(
				'http://agent-server:3001/sessions/session-123/pause',
				expect.objectContaining({ method: 'POST' }),
			)
		})

		it('throws when agent-server returns error', async () => {
			const { manager } = createManager()
			mockJsonResponse(400, { error: 'Session not in running state' })

			await expect(manager.pauseSession('session-123')).rejects.toThrow(
				'Session not in running state',
			)
		})
	})

	describe('resumeSession()', () => {
		it('sends resume request to agent-server', async () => {
			const { manager } = createManager()
			mockJsonResponse(200, { ok: true })
			mockSseResponse()

			await manager.resumeSession('session-123')

			expect(mockFetch).toHaveBeenCalledWith(
				'http://agent-server:3001/sessions/session-123/resume',
				expect.objectContaining({ method: 'POST' }),
			)

			await manager.stop()
		})

		it('throws when agent-server returns error', async () => {
			const { manager } = createManager()
			mockJsonResponse(400, { error: 'Session not in paused state or no snapshot' })

			await expect(manager.resumeSession('session-123')).rejects.toThrow(
				'Session not in paused state or no snapshot',
			)
		})
	})

	describe('start() and stop()', () => {
		it('starts and stops without error', async () => {
			const { manager, mockResults } = createManager()
			mockResults.select = []

			await manager.start()
			await manager.stop()
		})

		it('reconnects to active session log streams on start', async () => {
			const { manager, mockResults } = createManager()
			mockResults.select = [{ id: 'active-session-1' }]
			mockSseResponse()

			await manager.start()

			expect(mockFetch).toHaveBeenCalledWith(
				'http://agent-server:3001/sessions/active-session-1/logs/stream',
				expect.objectContaining({
					headers: { 'X-Agent-Server-Secret': 'test-secret' },
				}),
			)

			await manager.stop()
		})
	})
})
