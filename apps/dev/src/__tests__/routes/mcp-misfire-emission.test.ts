import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Simulate the SDK writing a JSON-RPC response into nodeRes.end() so the /mcp
// route's response-sniffer can classify it. Each test seeds
// `handleRequestBehavior` before calling into the route.
const { mockConnect, mockHandleRequest, MockTransport, mockCreateMcpServer } = vi.hoisted(() => {
	const mockConnect = vi.fn().mockResolvedValue(undefined)
	const mockHandleRequest = vi.fn()
	const MockTransport = vi.fn().mockImplementation(() => ({
		handleRequest: mockHandleRequest,
	}))
	const mockCreateMcpServer = vi.fn().mockReturnValue({
		connect: mockConnect,
	})
	return { mockConnect, mockHandleRequest, MockTransport, mockCreateMcpServer }
})

vi.mock('@maskin/mcp', () => ({
	createMcpServer: mockCreateMcpServer,
}))

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

const recordMcpMisfire = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/mcp-misfire', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-misfire')>()
	return { ...actual, recordMcpMisfire }
})

const validateApiKey = vi.fn().mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
vi.mock('@maskin/auth', () => ({
	validateApiKey,
	generateApiKey: vi.fn(),
	hashPassword: vi.fn(),
	verifyPassword: vi.fn(),
	authMiddleware: vi.fn(),
}))

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

function createApp() {
	const app = new Hono()
	// Stub a db so the route's actor-lookup runs (validateApiKey is mocked
	// separately). Real db access is never exercised in these tests.
	app.use('*', async (c, next) => {
		c.set('db', {} as never)
		await next()
	})
	return import('../../routes/mcp').then((mod) => {
		app.route('/mcp', mod.default)
		return app
	})
}

async function flushMicrotasks() {
	// The classifier runs as a `void` promise after the route returns; give
	// the microtask queue a couple of ticks to drain before asserting.
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
}

describe('MCP misfire emission via /mcp response sniffing', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	it('emits tool_not_found when the transport responds with "Tool X not found"', async () => {
		mockHandleRequest.mockImplementation(async (_req, res) => {
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 7,
					error: { code: -32602, message: 'Tool imaginary_tool not found' },
				}),
			)
		})

		const app = await createApp()
		const { env } = createEnv()
		const body = {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'imaginary_tool', arguments: { workspace_id: 'ws-1' } },
		}

		await app.request(
			jsonPostRequest('/mcp', body, {
				Authorization: 'Bearer ank_test',
				'X-Workspace-Id': '00000000-0000-0000-0000-000000000001',
			}),
			undefined,
			env,
		)
		await flushMicrotasks()

		expect(recordMcpMisfire).toHaveBeenCalledTimes(1)
		expect(recordMcpMisfire).toHaveBeenCalledWith(
			expect.anything(),
			'00000000-0000-0000-0000-000000000001',
			expect.objectContaining({
				kind: 'tool_not_found',
				toolName: 'imaginary_tool',
				agentActorId: 'actor-42',
				requestedShape: { workspace_id: 'string' },
			}),
		)
	})

	it('emits unknown_param on "Unrecognized key" schema errors', async () => {
		mockHandleRequest.mockImplementation(async (_req, res) => {
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					error: {
						code: -32602,
						message:
							"Invalid arguments for tool create_objects: Unrecognized key(s) in object: 'foo'",
					},
				}),
			)
		})

		const app = await createApp()
		const { env } = createEnv()
		const body = {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'create_objects', arguments: { foo: 1, title: 'x' } },
		}
		await app.request(
			jsonPostRequest('/mcp', body, {
				Authorization: 'Bearer ank_test',
				'X-Workspace-Id': '00000000-0000-0000-0000-000000000001',
			}),
			undefined,
			env,
		)
		await flushMicrotasks()

		expect(recordMcpMisfire).toHaveBeenCalledWith(
			expect.anything(),
			'00000000-0000-0000-0000-000000000001',
			expect.objectContaining({
				kind: 'unknown_param',
				toolName: 'create_objects',
				requestedShape: { foo: 'number', title: 'string' },
			}),
		)
	})

	it('emits schema_validation_error for other -32602 errors', async () => {
		mockHandleRequest.mockImplementation(async (_req, res) => {
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 2,
					error: { code: -32602, message: 'Invalid arguments for tool: expected string' },
				}),
			)
		})

		const app = await createApp()
		const { env } = createEnv()
		const body = {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'update_objects', arguments: { id: 3 } },
		}
		await app.request(
			jsonPostRequest('/mcp', body, {
				Authorization: 'Bearer ank_test',
				'X-Workspace-Id': '00000000-0000-0000-0000-000000000001',
			}),
			undefined,
			env,
		)
		await flushMicrotasks()

		expect(recordMcpMisfire).toHaveBeenCalledWith(
			expect.anything(),
			'00000000-0000-0000-0000-000000000001',
			expect.objectContaining({
				kind: 'schema_validation_error',
				toolName: 'update_objects',
			}),
		)
	})

	it('does NOT emit for InternalError (-32603) or successful responses', async () => {
		mockHandleRequest.mockImplementation(async (_req, res) => {
			res.end(
				JSON.stringify([
					{ jsonrpc: '2.0', id: 1, result: { content: [] } },
					{
						jsonrpc: '2.0',
						id: 2,
						error: { code: -32603, message: 'boom' },
					},
				]),
			)
		})

		const app = await createApp()
		const { env } = createEnv()
		await app.request(
			jsonPostRequest(
				'/mcp',
				[
					{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
					{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } },
				],
				{
					Authorization: 'Bearer ank_test',
					'X-Workspace-Id': '00000000-0000-0000-0000-000000000001',
				},
			),
			undefined,
			env,
		)
		await flushMicrotasks()

		expect(recordMcpMisfire).not.toHaveBeenCalled()
	})

	it('parses SSE-framed response bodies (data: lines)', async () => {
		mockHandleRequest.mockImplementation(async (_req, res) => {
			const payload = JSON.stringify({
				jsonrpc: '2.0',
				id: 9,
				error: { code: -32602, message: 'Tool ghost_tool not found' },
			})
			res.write(`event: message\ndata: ${payload}\n\n`)
			res.end()
		})

		const app = await createApp()
		const { env } = createEnv()
		const body = {
			jsonrpc: '2.0',
			id: 9,
			method: 'tools/call',
			params: { name: 'ghost_tool', arguments: {} },
		}
		await app.request(
			jsonPostRequest('/mcp', body, {
				Authorization: 'Bearer ank_test',
				'X-Workspace-Id': '00000000-0000-0000-0000-000000000001',
			}),
			undefined,
			env,
		)
		await flushMicrotasks()

		expect(recordMcpMisfire).toHaveBeenCalledWith(
			expect.anything(),
			'00000000-0000-0000-0000-000000000001',
			expect.objectContaining({ kind: 'tool_not_found', toolName: 'ghost_tool' }),
		)
	})
})
