import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, mockHandleRequest, mockClose, MockTransport, mockCreateMcpServer } =
	vi.hoisted(() => {
		const mockConnect = vi.fn().mockResolvedValue(undefined)
		const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
		const mockClose = vi.fn().mockResolvedValue(undefined)
		const MockTransport = vi.fn().mockImplementation(() => ({
			handleRequest: mockHandleRequest,
			close: mockClose,
			sessionId: 'test-session-id',
		}))
		const mockCreateMcpServer = vi.fn().mockReturnValue({
			connect: mockConnect,
		})
		return { mockConnect, mockHandleRequest, mockClose, MockTransport, mockCreateMcpServer }
	})

vi.mock('@maskin/mcp', () => ({
	createMcpServer: mockCreateMcpServer,
}))

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

import { Hono } from 'hono'

function createApp() {
	const app = new Hono()
	return import('../../routes/mcp').then((mod) => {
		app.route('/mcp', mod.default)
		return app
	})
}

function jsonPostRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

function createEnv() {
	const mockNodeReq = { url: '/mcp', method: 'POST' }
	const mockNodeRes = {
		writeHead: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		headersSent: false,
		setHeader: vi.fn(),
	}
	return { mockNodeReq, mockNodeRes, env: { incoming: mockNodeReq, outgoing: mockNodeRes } }
}

let mockNodeReq: ReturnType<typeof createEnv>['mockNodeReq']
let mockNodeRes: ReturnType<typeof createEnv>['mockNodeRes']
let env: ReturnType<typeof createEnv>['env']

describe('MCP Routes', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;({ mockNodeReq, mockNodeRes, env } = createEnv())
	})

	describe('GET /mcp', () => {
		it('returns 404 when no session ID provided', async () => {
			const app = await createApp()
			const res = await app.request(
				new Request('http://localhost/mcp', { method: 'GET' }),
				undefined,
				env,
			)

			expect(res.status).toBe(404)
			expect(await res.text()).toBe('Session not found. Send a POST request first to initialize.')
		})

		it('returns 404 for unknown session ID', async () => {
			const app = await createApp()
			const res = await app.request(
				new Request('http://localhost/mcp', {
					method: 'GET',
					headers: { 'mcp-session-id': 'nonexistent-session' },
				}),
				undefined,
				env,
			)

			expect(res.status).toBe(404)
		})

		it('opens SSE stream for existing session', async () => {
			const app = await createApp()

			// Create a session first
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }
			await app.request(
				jsonPostRequest('/mcp', body, { Authorization: 'Bearer key' }),
				undefined,
				env,
			)

			// GET with session ID should delegate to transport
			const { env: sseEnv, mockNodeReq: sseReq, mockNodeRes: sseRes } = createEnv()
			const res = await app.request(
				new Request('http://localhost/mcp', {
					method: 'GET',
					headers: { 'mcp-session-id': 'test-session-id' },
				}),
				undefined,
				sseEnv,
			)

			expect(res.headers.get('x-hono-already-sent')).toBe('1')
			// handleRequest called without body for SSE
			expect(mockHandleRequest).toHaveBeenCalledWith(sseReq, sseRes)
		})
	})

	describe('DELETE /mcp', () => {
		it('returns 404 when session not found', async () => {
			const app = await createApp()
			const res = await app.request(
				new Request('http://localhost/mcp', {
					method: 'DELETE',
					headers: { 'mcp-session-id': 'nonexistent' },
				}),
				undefined,
				env,
			)

			expect(res.status).toBe(404)
			expect(await res.text()).toBe('Session not found')
		})

		it('terminates an existing session and cleans up', async () => {
			const app = await createApp()

			// Create a session first
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }
			await app.request(
				jsonPostRequest('/mcp', body, { Authorization: 'Bearer key' }),
				undefined,
				env,
			)

			// Delete the session
			const { env: deleteEnv } = createEnv()
			const res = await app.request(
				new Request('http://localhost/mcp', {
					method: 'DELETE',
					headers: { 'mcp-session-id': 'test-session-id' },
				}),
				undefined,
				deleteEnv,
			)

			expect(res.status).toBe(200)
			expect(await res.text()).toBe('Session terminated')
			expect(mockClose).toHaveBeenCalledTimes(1)

			// Subsequent request with same session ID should create a new session
			const { env: env3 } = createEnv()
			await app.request(
				jsonPostRequest('/mcp', body, {
					Authorization: 'Bearer key',
					'mcp-session-id': 'test-session-id',
				}),
				undefined,
				env3,
			)
			expect(mockCreateMcpServer).toHaveBeenCalledTimes(2)
		})
	})

	describe('POST /mcp', () => {
		it('creates MCP server and transport, then delegates to handleRequest', async () => {
			const app = await createApp()
			const body = { jsonrpc: '2.0', method: 'tools/list', id: 1 }

			const res = await app.request(
				jsonPostRequest('/mcp', body, { Authorization: 'Bearer ank_test123' }),
				undefined,
				env,
			)

			expect(mockCreateMcpServer).toHaveBeenCalledWith(
				expect.objectContaining({
					apiKey: 'ank_test123',
				}),
			)

			expect(MockTransport).toHaveBeenCalledWith({
				sessionIdGenerator: expect.any(Function),
				enableJsonResponse: true,
			})

			expect(mockConnect).toHaveBeenCalledTimes(1)
			expect(mockHandleRequest).toHaveBeenCalledWith(mockNodeReq, mockNodeRes, body)

			expect(res.headers.get('x-hono-already-sent')).toBe('1')
		})

		it('extracts API key from Authorization header', async () => {
			const app = await createApp()
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }

			await app.request(
				jsonPostRequest('/mcp', body, { Authorization: 'Bearer my-secret-key' }),
				undefined,
				env,
			)

			expect(mockCreateMcpServer).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'my-secret-key' }),
			)
		})

		it('falls back to key query param when no Authorization header', async () => {
			const app = await createApp()
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }

			await app.request(
				new Request('http://localhost/mcp?key=query-key', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				undefined,
				env,
			)

			expect(mockCreateMcpServer).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'query-key' }),
			)
		})

		it('extracts workspace from X-Workspace-Id header', async () => {
			const app = await createApp()
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }

			await app.request(
				jsonPostRequest('/mcp', body, {
					Authorization: 'Bearer key',
					'X-Workspace-Id': 'ws-header-123',
				}),
				undefined,
				env,
			)

			expect(mockCreateMcpServer).toHaveBeenCalledWith(
				expect.objectContaining({ defaultWorkspaceId: 'ws-header-123' }),
			)
		})

		it('falls back to workspace query param when no header', async () => {
			const app = await createApp()
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }

			await app.request(
				new Request('http://localhost/mcp?workspace=ws-query-456', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				undefined,
				env,
			)

			expect(mockCreateMcpServer).toHaveBeenCalledWith(
				expect.objectContaining({ defaultWorkspaceId: 'ws-query-456' }),
			)
		})

		it('returns 400 for invalid JSON body', async () => {
			const app = await createApp()

			const res = await app.request(
				new Request('http://localhost/mcp', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: 'not valid json {{{',
				}),
				undefined,
				env,
			)

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(json.error.code).toBe('BAD_REQUEST')
			expect(json.error.message).toBe('Invalid JSON in request body')
		})

		it('defaults apiKey and workspace to empty string when not provided', async () => {
			const app = await createApp()
			const body = { jsonrpc: '2.0', method: 'initialize', id: 1 }

			await app.request(jsonPostRequest('/mcp', body), undefined, env)

			expect(mockCreateMcpServer).toHaveBeenCalledWith(
				expect.objectContaining({
					apiKey: '',
					defaultWorkspaceId: '',
					apiBaseUrl: 'http://localhost:3000',
				}),
			)
		})

		it('handles batch JSON-RPC array requests', async () => {
			const app = await createApp()
			const body = [
				{ jsonrpc: '2.0', method: 'tools/list', id: 1 },
				{ jsonrpc: '2.0', method: 'tools/call', id: 2 },
			]

			const res = await app.request(
				jsonPostRequest('/mcp', body, { Authorization: 'Bearer ank_batch' }),
				undefined,
				env,
			)

			expect(mockConnect).toHaveBeenCalledTimes(1)
			expect(mockHandleRequest).toHaveBeenCalledWith(mockNodeReq, mockNodeRes, body)
			expect(res.headers.get('x-hono-already-sent')).toBe('1')
		})

		it('reuses existing session when mcp-session-id header is provided', async () => {
			const app = await createApp()

			// First request creates a session
			const initBody = { jsonrpc: '2.0', method: 'initialize', id: 1 }
			await app.request(
				jsonPostRequest('/mcp', initBody, { Authorization: 'Bearer key' }),
				undefined,
				env,
			)

			expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
			expect(mockConnect).toHaveBeenCalledTimes(1)

			// Second request reuses the session
			const listBody = { jsonrpc: '2.0', method: 'tools/list', id: 2 }
			const { env: env2, mockNodeReq: req2, mockNodeRes: res2 } = createEnv()
			await app.request(
				jsonPostRequest('/mcp', listBody, {
					Authorization: 'Bearer key',
					'mcp-session-id': 'test-session-id',
				}),
				undefined,
				env2,
			)

			// Should NOT create a new server or transport
			expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
			expect(mockConnect).toHaveBeenCalledTimes(1)
			// Should still call handleRequest on the existing transport
			expect(mockHandleRequest).toHaveBeenCalledWith(req2, res2, listBody)
		})
	})
})
