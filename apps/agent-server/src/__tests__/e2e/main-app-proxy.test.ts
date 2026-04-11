import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('@maskin/db/schema', () => ({
	sessions: { id: 'id', status: 'status' },
}))

vi.mock('drizzle-orm', () => ({
	eq: vi.fn((...args: unknown[]) => args),
	inArray: vi.fn((...args: unknown[]) => args),
}))

vi.mock('../../../../dev/src/lib/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}))

import { SessionManager } from '../../../../dev/src/services/session-manager'
import { buildSession } from '../factories'
import { createTestContext } from '../setup'

const AGENT_SERVER_URL = 'http://agent-server:3001'
const AGENT_SECRET = 'test-shared-secret'

function createManager() {
	const ctx = createTestContext()
	const manager = new SessionManager(ctx.db, AGENT_SERVER_URL, AGENT_SECRET)
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

function mockSseResponse(events = 'event:done\ndata:\n\n') {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				read: vi
					.fn()
					.mockResolvedValueOnce({
						done: false,
						value: new TextEncoder().encode(events),
					})
					.mockResolvedValue({ done: true, value: undefined }),
			}),
		},
	})
}

describe('Main App → Agent Server Proxy (SessionManager thin client)', () => {
	afterEach(async () => {
		mockFetch.mockReset()
	})

	describe('createSession()', () => {
		it('sends POST /sessions with correct headers, body, and URL', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'pending' })

			mockJsonResponse(201, { id: session.id })
			mockResults.select = [session]

			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test action',
				createdBy: 'main-app',
				autoStart: false,
			})

			expect(mockFetch).toHaveBeenCalledTimes(1)
			expect(mockFetch).toHaveBeenCalledWith(
				`${AGENT_SERVER_URL}/sessions`,
				expect.objectContaining({
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'X-Agent-Server-Secret': AGENT_SECRET,
					},
					body: JSON.stringify({
						workspace_id: 'ws-1',
						actor_id: 'actor-1',
						action_prompt: 'Test action',
						created_by: 'main-app',
						auto_start: false,
					}),
				}),
			)

			await manager.stop()
		})

		it('includes optional config and trigger_id in request body', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'pending' })

			mockJsonResponse(201, { id: session.id })
			mockResults.select = [session]

			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test action',
				config: { model: 'claude-4' },
				triggerId: 'trigger-abc',
				createdBy: 'main-app',
				autoStart: false,
			})

			const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
			expect(callBody.config).toEqual({ model: 'claude-4' })
			expect(callBody.trigger_id).toBe('trigger-abc')

			await manager.stop()
		})

		it('subscribes to SSE logs after create when autoStart is true', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			mockJsonResponse(201, { id: session.id })
			mockSseResponse()
			mockResults.select = [session]

			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test action',
				createdBy: 'main-app',
				autoStart: true,
			})

			expect(mockFetch).toHaveBeenCalledTimes(2)
			expect(mockFetch).toHaveBeenNthCalledWith(
				1,
				`${AGENT_SERVER_URL}/sessions`,
				expect.objectContaining({ method: 'POST' }),
			)
			expect(mockFetch).toHaveBeenNthCalledWith(
				2,
				`${AGENT_SERVER_URL}/sessions/${session.id}/logs/stream`,
				expect.objectContaining({
					headers: { 'X-Agent-Server-Secret': AGENT_SECRET },
				}),
			)

			await manager.stop()
		})

		it('does not subscribe to logs when autoStart is false', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'pending' })

			mockJsonResponse(201, { id: session.id })
			mockResults.select = [session]

			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test action',
				createdBy: 'main-app',
				autoStart: false,
			})

			expect(mockFetch).toHaveBeenCalledTimes(1)

			await manager.stop()
		})

		it('reads back from shared DB for consistent types', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running', actionPrompt: 'DB version' })

			mockJsonResponse(201, { id: session.id })
			mockResults.select = [session]

			const result = await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test action',
				createdBy: 'main-app',
				autoStart: false,
			})

			expect(result).toEqual(session)

			await manager.stop()
		})
	})

	describe('stopSession()', () => {
		it('sends POST /sessions/:id/stop with auth header', async () => {
			const { manager } = createManager()
			mockJsonResponse(200, { ok: true })

			await manager.stopSession('session-to-stop')

			expect(mockFetch).toHaveBeenCalledWith(
				`${AGENT_SERVER_URL}/sessions/session-to-stop/stop`,
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						'X-Agent-Server-Secret': AGENT_SECRET,
					}),
				}),
			)

			await manager.stop()
		})

		it('unsubscribes from logs after stopping', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			mockJsonResponse(201, { id: session.id })
			mockSseResponse()
			mockResults.select = [session]
			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test',
				createdBy: 'test',
				autoStart: true,
			})

			mockJsonResponse(200, { ok: true })
			await manager.stopSession(session.id)

			// Resume creates a new SSE subscription, proving the old one was cleaned up
			mockJsonResponse(200, { ok: true })
			mockSseResponse()
			await manager.resumeSession(session.id)

			// 5 calls: create POST + first SSE + stop POST + resume POST + new SSE
			expect(mockFetch).toHaveBeenCalledTimes(5)

			await manager.stop()
		})
	})

	describe('pauseSession()', () => {
		it('sends POST /sessions/:id/pause with auth header', async () => {
			const { manager } = createManager()
			mockJsonResponse(200, { ok: true })

			await manager.pauseSession('session-to-pause')

			expect(mockFetch).toHaveBeenCalledWith(
				`${AGENT_SERVER_URL}/sessions/session-to-pause/pause`,
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						'X-Agent-Server-Secret': AGENT_SECRET,
					}),
				}),
			)

			await manager.stop()
		})

		it('unsubscribes from logs after pausing', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			mockJsonResponse(201, { id: session.id })
			mockSseResponse()
			mockResults.select = [session]
			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test',
				createdBy: 'test',
				autoStart: true,
			})

			mockJsonResponse(200, { ok: true })
			await manager.pauseSession(session.id)

			// Resume creates a new SSE subscription, proving the old one was cleaned up
			mockJsonResponse(200, { ok: true })
			mockSseResponse()
			await manager.resumeSession(session.id)

			// 5 calls: create POST + first SSE + pause POST + resume POST + new SSE
			expect(mockFetch).toHaveBeenCalledTimes(5)

			await manager.stop()
		})
	})

	describe('resumeSession()', () => {
		it('sends POST /sessions/:id/resume and subscribes to logs', async () => {
			const { manager } = createManager()
			mockJsonResponse(200, { ok: true })
			mockSseResponse()

			await manager.resumeSession('session-to-resume')

			expect(mockFetch).toHaveBeenCalledTimes(2)
			expect(mockFetch).toHaveBeenNthCalledWith(
				1,
				`${AGENT_SERVER_URL}/sessions/session-to-resume/resume`,
				expect.objectContaining({ method: 'POST' }),
			)
			expect(mockFetch).toHaveBeenNthCalledWith(
				2,
				`${AGENT_SERVER_URL}/sessions/session-to-resume/logs/stream`,
				expect.objectContaining({
					headers: { 'X-Agent-Server-Secret': AGENT_SECRET },
				}),
			)

			await manager.stop()
		})
	})

	describe('Error propagation', () => {
		it('throws when agent-server returns 500 on create', async () => {
			const { manager } = createManager()
			mockJsonResponse(500, { error: 'Container creation failed' })

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Fail',
					createdBy: 'test',
					autoStart: false,
				}),
			).rejects.toThrow('Container creation failed')

			await manager.stop()
		})

		it('throws when agent-server returns 500 on stop', async () => {
			const { manager } = createManager()
			mockJsonResponse(500, { error: 'Internal error during stop' })

			await expect(manager.stopSession('session-1')).rejects.toThrow('Internal error during stop')

			await manager.stop()
		})

		it('throws when agent-server returns 500 on pause', async () => {
			const { manager } = createManager()
			mockJsonResponse(500, { error: 'Snapshot failed' })

			await expect(manager.pauseSession('session-1')).rejects.toThrow('Snapshot failed')

			await manager.stop()
		})

		it('throws when agent-server returns 500 on resume', async () => {
			const { manager } = createManager()
			mockJsonResponse(500, { error: 'Resume failed' })

			await expect(manager.resumeSession('session-1')).rejects.toThrow('Resume failed')

			await manager.stop()
		})

		it('throws when session not found in database after creation', async () => {
			const { manager, mockResults } = createManager()
			mockJsonResponse(201, { id: 'new-session-id' })
			mockResults.select = []

			await expect(
				manager.createSession('ws-1', {
					actorId: 'actor-1',
					actionPrompt: 'Test',
					createdBy: 'test',
					autoStart: false,
				}),
			).rejects.toThrow('Session created on agent-server but not found in database')

			await manager.stop()
		})

		it('uses status code in message when error body has no error field', async () => {
			const { manager } = createManager()
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 502,
				statusText: 'Bad Gateway',
				json: vi.fn().mockResolvedValue({}),
				body: null,
			})

			await expect(manager.stopSession('session-1')).rejects.toThrow('Failed to stop session: 502')

			await manager.stop()
		})

		it('handles json parse failure gracefully', async () => {
			const { manager } = createManager()
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 503,
				statusText: 'Service Unavailable',
				json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
				body: null,
			})

			await expect(manager.stopSession('session-1')).rejects.toThrow('Service Unavailable')

			await manager.stop()
		})
	})

	describe('SSE log subscription behavior', () => {
		it('emits log events from SSE stream', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			const ssePayload = [
				'event:stdout',
				'id:1',
				'data:Hello from agent',
				'',
				'event:stderr',
				'id:2',
				'data:Warning message',
				'',
				'event:done',
				'data:completed',
				'',
			].join('\n')

			mockJsonResponse(201, { id: session.id })
			mockSseResponse(ssePayload)
			mockResults.select = [session]

			const logEvents: unknown[] = []
			manager.on('log', (event: unknown) => logEvents.push(event))

			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test',
				createdBy: 'test',
				autoStart: true,
			})

			await vi.waitFor(() => {
				expect(logEvents.length).toBe(2)
			})

			expect(logEvents[0]).toEqual({
				sessionId: session.id,
				logId: 1,
				stream: 'stdout',
				data: 'Hello from agent',
			})
			expect(logEvents[1]).toEqual({
				sessionId: session.id,
				logId: 2,
				stream: 'stderr',
				data: 'Warning message',
			})

			await manager.stop()
		})

		it('cleans up subscription when SSE stream emits done event', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			mockJsonResponse(201, { id: session.id })
			mockSseResponse('event:done\ndata:\n\n')
			mockResults.select = [session]

			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test',
				createdBy: 'test',
				autoStart: true,
			})

			// Wait for SSE processing to complete, then verify cleanup by resuming
			// (which should create a new SSE subscription without dedup blocking it)
			await vi.waitFor(async () => {
				mockJsonResponse(200, { ok: true })
				mockSseResponse()
				await manager.resumeSession(session.id)
				// If cleanup happened, resume adds a new SSE sub (call 4 = SSE)
				const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]
				expect(lastCall[0]).toContain('/logs/stream')
			})

			await manager.stop()
		})

		it('reconnects to active session log streams on start()', async () => {
			const { manager, mockResults } = createManager()
			mockResults.select = [{ id: 'active-session-1' }, { id: 'active-session-2' }]
			mockSseResponse()
			mockSseResponse()

			await manager.start()

			expect(mockFetch).toHaveBeenCalledTimes(2)
			expect(mockFetch).toHaveBeenCalledWith(
				`${AGENT_SERVER_URL}/sessions/active-session-1/logs/stream`,
				expect.objectContaining({
					headers: { 'X-Agent-Server-Secret': AGENT_SECRET },
				}),
			)
			expect(mockFetch).toHaveBeenCalledWith(
				`${AGENT_SERVER_URL}/sessions/active-session-2/logs/stream`,
				expect.objectContaining({
					headers: { 'X-Agent-Server-Secret': AGENT_SECRET },
				}),
			)

			await manager.stop()
		})

		it('deduplicates log subscriptions for the same session', async () => {
			const { manager, mockResults } = createManager()
			const session = buildSession({ status: 'running' })

			// Use a long-lived SSE stream that never completes, so the subscription stays active
			mockJsonResponse(201, { id: session.id })
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				body: {
					getReader: () => ({
						read: vi.fn().mockReturnValue(new Promise(() => {})),
					}),
				},
			})
			mockResults.select = [session]
			await manager.createSession('ws-1', {
				actorId: 'actor-1',
				actionPrompt: 'Test',
				createdBy: 'test',
				autoStart: true,
			})

			// Resume the same session — subscribeToLogs should detect existing subscription
			mockJsonResponse(200, { ok: true })
			await manager.resumeSession(session.id)

			// 3 calls: create POST + SSE + resume POST (no second SSE due to dedup)
			expect(mockFetch).toHaveBeenCalledTimes(3)

			await manager.stop()
		})
	})
})
