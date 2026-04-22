import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
	mockConnect,
	mockHandleRequest,
	MockTransport,
	mockCreateMcpServer,
	mockShutdownAll,
	mockSessionLogShutdownAll,
} = vi.hoisted(() => {
	const mockConnect = vi.fn().mockResolvedValue(undefined)
	const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
	const mockShutdownAll = vi.fn().mockResolvedValue(undefined)
	const mockSessionLogShutdownAll = vi.fn().mockResolvedValue(undefined)
	const MockTransport = vi.fn().mockImplementation(() => ({
		handleRequest: mockHandleRequest,
	}))
	const mockCreateMcpServer = vi.fn().mockReturnValue({
		server: { connect: mockConnect },
		registry: { shutdownAll: mockShutdownAll, add: vi.fn(), remove: vi.fn(), list: vi.fn() },
		eventRegistry: { shutdownAll: mockShutdownAll, add: vi.fn(), remove: vi.fn(), list: vi.fn() },
		sessionLogRegistry: {
			shutdownAll: mockSessionLogShutdownAll,
			add: vi.fn(),
			remove: vi.fn(),
			list: vi.fn(),
		},
	})
	return {
		mockConnect,
		mockHandleRequest,
		MockTransport,
		mockCreateMcpServer,
		mockShutdownAll,
		mockSessionLogShutdownAll,
	}
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
		it('returns 405 Method Not Allowed', async () => {
			const app = await createApp()
			const res = await app.request(new Request('http://localhost/mcp', { method: 'GET' }))

			expect(res.status).toBe(405)
			expect(await res.text()).toBe('Method Not Allowed')
		})
	})

	describe('DELETE /mcp', () => {
		it('returns 405 Method Not Allowed', async () => {
			const app = await createApp()
			const res = await app.request(new Request('http://localhost/mcp', { method: 'DELETE' }))

			expect(res.status).toBe(405)
			expect(await res.text()).toBe('Method Not Allowed')
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
				sessionIdGenerator: undefined,
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
	})
})
