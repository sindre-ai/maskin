import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness shape as mcp-misfire-emission.test.ts: stub the MCP SDK so the
// route's response-sniffer sees a JSON-RPC body we control, then assert on the
// trace events emitted from the captured bytes.
const { mockHandleRequest, MockTransport, mockCreateMcpServer } = vi.hoisted(() => {
	const mockConnect = vi.fn().mockResolvedValue(undefined)
	const mockHandleRequest = vi.fn()
	const MockTransport = vi.fn().mockImplementation(() => ({ handleRequest: mockHandleRequest }))
	const mockCreateMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
	return { mockConnect, mockHandleRequest, MockTransport, mockCreateMcpServer }
})

vi.mock('@maskin/mcp', () => ({ createMcpServer: mockCreateMcpServer }))
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

const captureMcpToolCall = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/mcp-tool-calls', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-tool-calls')>()
	return { ...actual, captureMcpToolCall }
})

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

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const MASKIN_SESSION_ID = '33333333-3333-4333-8333-333333333333'

function createEnv() {
	const mockNodeRes = {
		writeHead: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		headersSent: false,
		setHeader: vi.fn(),
	}
	const mockNodeReq = { url: '/mcp', method: 'POST' }
	return { env: { incoming: mockNodeReq, outgoing: mockNodeRes } }
}

type TestEnv = { Variables: { db: unknown } }

async function createApp() {
	const app = new Hono<TestEnv>()
	app.use('*', async (c, next) => {
		c.set('db', {})
		await next()
	})
	const mod = await import('../../routes/mcp')
	app.route('/mcp', mod.default)
	// The actor cache and the sequence counter are both module-level, so reset
	// them per test or numbering leaks between cases.
	mod.__resetMcpActorCache()
	mod.__resetMcpTraceSeq()
	return app
}

/** Traces captured so far, typed for assertions. */
function traces(): Array<Record<string, unknown>> {
	return captureMcpToolCall.mock.calls.map((c) => c[1] as Record<string, unknown>)
}

async function post(app: Hono<TestEnv>, body: unknown, headers: Record<string, string> = {}) {
	const { env } = createEnv()
	await app.request(
		new Request('http://localhost/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer ank_test',
				'X-Workspace-Id': WORKSPACE_ID,
				...headers,
			},
			body: JSON.stringify(body),
		}),
		undefined,
		env,
	)
	// The emitter runs as a `void` promise after the route returns.
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
	await new Promise((r) => setImmediate(r))
}

function toolCall(id: number, name: string, args: unknown) {
	return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

function respondOk(id: number) {
	mockHandleRequest.mockImplementation(async (_req: unknown, res: { end: (s: string) => void }) => {
		res.end(
			JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } }),
		)
	})
}

describe('MCP tool-call trace emission via /mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	it('emits one trace per successful tools/call with the maskin session id', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', { workspace_id: 'ws', type: 'bet' }), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})

		expect(captureMcpToolCall).toHaveBeenCalledTimes(1)
		expect(captureMcpToolCall.mock.calls[0]?.[0]).toBe(WORKSPACE_ID)
		expect(traces()[0]).toMatchObject({
			sessionId: MASKIN_SESSION_ID,
			sessionSource: 'maskin-session',
			toolName: 'list_objects',
			argKeys: ['type', 'workspace_id'],
			ok: true,
			errorClass: null,
			transport: 'http',
			agentActorId: 'actor-42',
		})
	})

	it('numbers calls in order within one session and independently across sessions', async () => {
		const app = await createApp()
		for (const [i, name] of ['list_objects', 'get_objects', 'create_objects'].entries()) {
			respondOk(i + 1)
			await post(app, toolCall(i + 1, name, {}), { 'X-Maskin-Session-Id': MASKIN_SESSION_ID })
		}
		expect(traces().map((t) => [t.toolName, t.seq])).toEqual([
			['list_objects', 1],
			['get_objects', 2],
			['create_objects', 3],
		])

		// A different session starts its own numbering.
		respondOk(9)
		await post(app, toolCall(9, 'list_objects', {}), { 'X-Maskin-Session-Id': 'other-session' })
		expect(traces().at(-1)).toMatchObject({ sessionId: 'other-session', seq: 1 })
	})

	// Regression: `seq` used to be allocated inside the emitter, AFTER the
	// awaited actor lookup. A first call missing the actor cache waits on a DB
	// roundtrip while a second call arriving later hits the warm cache and
	// numbers itself first, inverting the order `seq` exists to record. Agents
	// issue tool calls in parallel routinely, so this is an ordinary case.
	it('numbers calls in arrival order even when the first actor lookup is slow', async () => {
		let resolveSlowLookup: ((v: unknown) => void) | undefined
		validateApiKey.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSlowLookup = resolve
				}),
		)
		respondOk(1)
		const app = await createApp()

		// First call starts and blocks inside the actor lookup.
		const first = post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})
		await new Promise((r) => setImmediate(r))

		// Second call arrives while the first is still blocked. Its own lookup
		// resolves immediately, so without a synchronous seq it would win.
		respondOk(2)
		const second = post(app, toolCall(2, 'get_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})
		await new Promise((r) => setImmediate(r))

		resolveSlowLookup?.({ actorId: 'actor-42', type: 'agent' })
		await Promise.all([first, second])

		const byTool = new Map(traces().map((t) => [t.toolName, t.seq]))
		expect(byTool.get('list_objects')).toBe(1)
		expect(byTool.get('get_objects')).toBe(2)
	})

	it('reuses the memoized actor across calls instead of re-querying per call', async () => {
		const app = await createApp()
		for (const [i, name] of ['list_objects', 'get_objects'].entries()) {
			respondOk(i + 1)
			await post(app, toolCall(i + 1, name, {}), { 'X-Maskin-Session-Id': MASKIN_SESSION_ID })
		}
		expect(validateApiKey).toHaveBeenCalledTimes(1)
		expect(traces().every((t) => t.agentActorId === 'actor-42')).toBe(true)
	})

	it('still records misfires when trace capture throws', async () => {
		captureMcpToolCall.mockRejectedValue(new Error('posthog exploded'))
		mockHandleRequest.mockImplementation(
			async (_req: unknown, res: { end: (s: string) => void }) => {
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 5,
						error: { code: -32602, message: 'Tool imaginary_tool not found' },
					}),
				)
			},
		)
		const app = await createApp()
		await post(app, toolCall(5, 'imaginary_tool', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})
		// The misfire metric predates tracing and must not be collateral damage.
		expect(recordMcpMisfire).toHaveBeenCalledTimes(1)
	})

	it('marks a failed call not-ok with a bucketed error class and still traces it', async () => {
		mockHandleRequest.mockImplementation(
			async (_req: unknown, res: { end: (s: string) => void }) => {
				res.end(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 5,
						error: { code: -32602, message: 'Tool imaginary_tool not found' },
					}),
				)
			},
		)
		const app = await createApp()
		await post(app, toolCall(5, 'imaginary_tool', { workspace_id: 'ws' }), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})

		expect(captureMcpToolCall).toHaveBeenCalledTimes(1)
		expect(traces()[0]).toMatchObject({
			toolName: 'imaginary_tool',
			ok: false,
			errorClass: 'tool_not_found',
		})
		// The pre-existing misfire path still fires alongside the trace.
		expect(recordMcpMisfire).toHaveBeenCalledTimes(1)
	})

	it('falls back to Mcp-Session-Id, then to an unknown-flagged id', async () => {
		respondOk(1)
		let app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), { 'Mcp-Session-Id': 'ext-1' })
		expect(traces()[0]).toMatchObject({ sessionId: 'ext-1', sessionSource: 'mcp-session' })

		captureMcpToolCall.mockClear()
		respondOk(1)
		app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}))
		expect(traces()[0]).toMatchObject({ sessionSource: 'unknown' })
	})

	it('does not emit a trace for non-tool-call methods', async () => {
		mockHandleRequest.mockImplementation(
			async (_req: unknown, res: { end: (s: string) => void }) => {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
			},
		)
		const app = await createApp()
		await post(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
		expect(captureMcpToolCall).not.toHaveBeenCalled()
	})

	it('emits one trace per call in a batched request', async () => {
		mockHandleRequest.mockImplementation(
			async (_req: unknown, res: { end: (s: string) => void }) => {
				res.end(
					JSON.stringify([
						{ jsonrpc: '2.0', id: 1, result: { content: [] } },
						{ jsonrpc: '2.0', id: 2, result: { content: [] } },
					]),
				)
			},
		)
		const app = await createApp()
		await post(app, [toolCall(1, 'list_objects', {}), toolCall(2, 'get_objects', {})], {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})
		expect(captureMcpToolCall).toHaveBeenCalledTimes(2)
		// Duration is not attributed when a batch shares one wall-clock reading.
		expect(traces()[0]?.durationMs).toBeNull()
	})
})
