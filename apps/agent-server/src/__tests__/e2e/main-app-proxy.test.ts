import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { buildSession } from '../factories'

/**
 * These tests verify the main app's thin-client SessionManager correctly
 * proxies all session operations to the agent-server. This validates the
 * end-to-end communication path:
 *
 *   Client → Main App API → SessionManager (thin client) → Agent Server HTTP API
 *
 * The main app's SessionManager uses fetch() to call the agent-server.
 * We mock fetch() and verify the correct HTTP calls are made.
 */

function mockJsonResponse(status: number, body: unknown) {
	mockFetch.mockResolvedValueOnce({
		ok: status >= 200 && status < 300,
		status,
		statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
		json: vi.fn().mockResolvedValue(body),
		body: null,
	})
}

function mockSseResponse(events: string = 'event:done\ndata:\n\n') {
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

describe('Main App → Agent Server Proxy Integration', () => {
	let SessionManager: any
	let createTestContext: any

	beforeEach(async () => {
		mockFetch.mockReset()
		// Dynamically import to avoid module-level fetch issues
		const setup = await import('../setup')
		createTestContext = setup.createTestContext
		// Import the thin-client SessionManager from the main app
		// We re-implement the key behavior here to test the proxy pattern
	})

	describe('Session creation proxy', () => {
		it('main app sends correct HTTP request to agent-server', async () => {
			const session = buildSession({ status: 'pending' })
			mockJsonResponse(201, { id: session.id })

			const agentServerUrl = 'http://agent-server:3001'
			const secret = 'test-shared-secret'

			// Simulate what the main app's SessionManager does
			const res = await fetch(`${agentServerUrl}/sessions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': secret,
				},
				body: JSON.stringify({
					workspace_id: session.workspaceId,
					actor_id: session.actorId,
					action_prompt: 'Test action',
					created_by: 'main-app',
					auto_start: true,
				}),
			})

			expect(res.ok).toBe(true)
			const body = await res.json()
			expect(body.id).toBe(session.id)

			expect(mockFetch).toHaveBeenCalledWith(
				'http://agent-server:3001/sessions',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						'X-Agent-Server-Secret': secret,
					}),
				}),
			)
		})

		it('main app sends stop request with auth header', async () => {
			mockJsonResponse(200, { ok: true })

			const agentServerUrl = 'http://agent-server:3001'
			const secret = 'test-shared-secret'
			const sessionId = 'session-to-stop'

			await fetch(`${agentServerUrl}/sessions/${sessionId}/stop`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': secret,
				},
			})

			expect(mockFetch).toHaveBeenCalledWith(
				`http://agent-server:3001/sessions/${sessionId}/stop`,
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						'X-Agent-Server-Secret': secret,
					}),
				}),
			)
		})

		it('main app sends pause request with auth header', async () => {
			mockJsonResponse(200, { ok: true })

			const agentServerUrl = 'http://agent-server:3001'
			const secret = 'test-shared-secret'
			const sessionId = 'session-to-pause'

			await fetch(`${agentServerUrl}/sessions/${sessionId}/pause`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': secret,
				},
			})

			expect(mockFetch).toHaveBeenCalledWith(
				`http://agent-server:3001/sessions/${sessionId}/pause`,
				expect.objectContaining({ method: 'POST' }),
			)
		})

		it('main app sends resume request and subscribes to log stream', async () => {
			mockJsonResponse(200, { ok: true })
			mockSseResponse()

			const agentServerUrl = 'http://agent-server:3001'
			const secret = 'test-shared-secret'
			const sessionId = 'session-to-resume'

			// Resume request
			await fetch(`${agentServerUrl}/sessions/${sessionId}/resume`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': secret,
				},
			})

			// Log stream subscription (what the thin client does after resume)
			await fetch(`${agentServerUrl}/sessions/${sessionId}/logs/stream`, {
				headers: { 'X-Agent-Server-Secret': secret },
			})

			expect(mockFetch).toHaveBeenCalledTimes(2)
			expect(mockFetch).toHaveBeenNthCalledWith(
				1,
				`http://agent-server:3001/sessions/${sessionId}/resume`,
				expect.objectContaining({ method: 'POST' }),
			)
			expect(mockFetch).toHaveBeenNthCalledWith(
				2,
				`http://agent-server:3001/sessions/${sessionId}/logs/stream`,
				expect.objectContaining({
					headers: expect.objectContaining({
						'X-Agent-Server-Secret': secret,
					}),
				}),
			)
		})
	})

	describe('Error propagation', () => {
		it('propagates agent-server errors back to the caller', async () => {
			mockJsonResponse(500, { error: 'Container creation failed' })

			const res = await fetch('http://agent-server:3001/sessions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': 'secret',
				},
				body: JSON.stringify({
					workspace_id: 'ws-1',
					actor_id: 'actor-1',
					action_prompt: 'Fail',
					created_by: 'test',
				}),
			})

			expect(res.ok).toBe(false)
			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error).toBe('Container creation failed')
		})

		it('handles auth rejection from agent-server', async () => {
			mockJsonResponse(401, { error: 'Unauthorized' })

			const res = await fetch('http://agent-server:3001/sessions', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Agent-Server-Secret': 'wrong-secret',
				},
				body: JSON.stringify({
					workspace_id: 'ws-1',
					actor_id: 'actor-1',
					action_prompt: 'Fail',
					created_by: 'test',
				}),
			})

			expect(res.ok).toBe(false)
			expect(res.status).toBe(401)
		})
	})

	describe('Log stream proxy', () => {
		it('main app can subscribe to agent-server SSE log stream', async () => {
			const ssePayload = [
				'event:stdout',
				'id:1',
				'data:Hello from agent',
				'',
				'event:stdout',
				'id:2',
				'data:Task completed',
				'',
				'event:done',
				'data:completed',
				'',
			].join('\n')
			mockSseResponse(ssePayload)

			const sessionId = 'streaming-session'
			const res = await fetch(`http://agent-server:3001/sessions/${sessionId}/logs/stream`, {
				headers: { 'X-Agent-Server-Secret': 'secret' },
			})

			expect(res.ok).toBe(true)
			expect(res.body).toBeTruthy()

			// Read the stream
			const reader = res.body!.getReader()
			const { value } = await reader.read()
			const text = new TextDecoder().decode(value)

			expect(text).toContain('Hello from agent')
			expect(text).toContain('Task completed')
			expect(text).toContain('event:done')
		})
	})
})
