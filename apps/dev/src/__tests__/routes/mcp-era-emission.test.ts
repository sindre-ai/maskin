import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as mcp-trace-emission.test.ts: stub the MCP SDK so the route's
// response sniffer sees a JSON-RPC body we control, then assert on what the
// route hands to the analytics layer. Covers the era marker: the label on every
// event, the mcp_handshake event, and the single classification per POST.
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
const captureMcpHandshake = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/mcp-tool-calls', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-tool-calls')>()
	return { ...actual, captureMcpToolCall, captureMcpHandshake }
})

const recordMcpMisfire = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/mcp-misfire', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-misfire')>()
	return { ...actual, recordMcpMisfire }
})

const classifyMcpEra = vi.fn()
vi.mock('../../lib/analytics/mcp-era', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-era')>()
	classifyMcpEra.mockImplementation(actual.classifyMcpEra)
	return { ...actual, classifyMcpEra }
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
	mod.__resetMcpActorCache()
	mod.__resetMcpTraceSeq()
	return app
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
				'X-Maskin-Session-Id': MASKIN_SESSION_ID,
				...headers,
			},
			body: JSON.stringify(body),
		}),
		undefined,
		env,
	)
	// The emitter runs as a `void` promise after the route returns.
	for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
}

function respondWith(payload: unknown) {
	mockHandleRequest.mockImplementation(async (_req: unknown, res: { end: (s: string) => void }) => {
		res.end(JSON.stringify(payload))
	})
}

const toolCall = (id: number, name: string) => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name, arguments: {} },
})
const initialize = (id: number) => ({
	jsonrpc: '2.0',
	id,
	method: 'initialize',
	params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'free text' } },
})
const discover = (id: number) => ({ jsonrpc: '2.0', id, method: 'server/discover' })
const okResult = (id: number) => ({ jsonrpc: '2.0', id, result: { content: [] } })

const traceProps = () => captureMcpToolCall.mock.calls.map((c) => c[1] as Record<string, unknown>)
const handshakeProps = () =>
	captureMcpHandshake.mock.calls.map((c) => c[1] as Record<string, unknown>)

describe('MCP era marker via /mcp', () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		const actual = await vi.importActual<typeof import('../../lib/analytics/mcp-era')>(
			'../../lib/analytics/mcp-era',
		)
		classifyMcpEra.mockImplementation(actual.classifyMcpEra)
		captureMcpToolCall.mockResolvedValue(undefined)
		captureMcpHandshake.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	it('labels a tool call legacy with the declared protocol version', async () => {
		respondWith(okResult(1))
		await post(await createApp(), toolCall(1, 'list_objects'), {
			'MCP-Protocol-Version': '2025-06-18',
		})
		expect(traceProps()[0]).toMatchObject({ mcpEra: 'legacy', mcpProtocolVersion: '2025-06-18' })
	})

	it('labels a call with no header and no handshake legacy / none', async () => {
		respondWith(okResult(1))
		await post(await createApp(), toolCall(1, 'list_objects'))
		expect(traceProps()[0]).toMatchObject({ mcpEra: 'legacy', mcpProtocolVersion: 'none' })
	})

	it('never carries the raw header value into the trace', async () => {
		respondWith(okResult(1))
		await post(await createApp(), toolCall(1, 'list_objects'), {
			'MCP-Protocol-Version': 'ank_0123456789abcdef',
		})
		expect(traceProps()[0]).toMatchObject({ mcpProtocolVersion: 'other' })
		expect(JSON.stringify(traceProps()[0])).not.toContain('ank_0123')
	})

	it('classifies once per POST and threads the answer into the server config', async () => {
		respondWith(okResult(1))
		await post(await createApp(), toolCall(1, 'list_objects'), {
			'MCP-Protocol-Version': '2025-11-25',
		})
		expect(classifyMcpEra).toHaveBeenCalledTimes(1)
		expect(mockCreateMcpServer.mock.calls[0]?.[0]).toMatchObject({
			telemetryEra: 'legacy',
			telemetryProtocolVersion: '2025-11-25',
		})
	})

	it('shares one era across a batch', async () => {
		respondWith([okResult(1), okResult(2)])
		await post(await createApp(), [toolCall(1, 'list_objects'), toolCall(2, 'get_objects')], {
			'MCP-Protocol-Version': '2025-03-26',
		})
		expect(classifyMcpEra).toHaveBeenCalledTimes(1)
		expect(traceProps().map((t) => t.mcpEra)).toEqual(['legacy', 'legacy'])
		expect(traceProps().map((t) => t.mcpProtocolVersion)).toEqual(['2025-03-26', '2025-03-26'])
	})

	it('labels misfires with the same era', async () => {
		respondWith({
			jsonrpc: '2.0',
			id: 5,
			error: { code: -32602, message: 'Tool imaginary_tool not found' },
		})
		await post(await createApp(), toolCall(5, 'imaginary_tool'), {
			'MCP-Protocol-Version': '2025-06-18',
		})
		expect(recordMcpMisfire.mock.calls[0]?.[2]).toMatchObject({
			mcpEra: 'legacy',
			mcpProtocolVersion: '2025-06-18',
		})
	})

	// A classifier fault must cost the label and nothing else: the request is
	// served, the events still go out, and the properties are absent (not guessed).
	it('omits the labels and still serves and traces when the classifier throws', async () => {
		classifyMcpEra.mockImplementation(() => {
			throw new Error('classifier exploded')
		})
		respondWith(okResult(1))
		await post(await createApp(), toolCall(1, 'list_objects'))

		expect(mockHandleRequest).toHaveBeenCalledTimes(1)
		expect(traceProps()).toHaveLength(1)
		expect(traceProps()[0]?.mcpEra).toBeUndefined()
		expect(traceProps()[0]?.mcpProtocolVersion).toBeUndefined()
		expect(mockCreateMcpServer.mock.calls[0]?.[0].telemetryEra).toBeUndefined()
	})
})

describe('mcp_handshake via /mcp', () => {
	beforeEach(async () => {
		vi.clearAllMocks()
		const actual = await vi.importActual<typeof import('../../lib/analytics/mcp-era')>(
			'../../lib/analytics/mcp-era',
		)
		classifyMcpEra.mockImplementation(actual.classifyMcpEra)
		captureMcpToolCall.mockResolvedValue(undefined)
		captureMcpHandshake.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	it('emits exactly one handshake for an initialize, with no tool_call event', async () => {
		respondWith({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })
		await post(await createApp(), initialize(1), { 'User-Agent': 'claude-cli/2.0.14' })

		expect(captureMcpHandshake).toHaveBeenCalledTimes(1)
		expect(captureMcpHandshake.mock.calls[0]?.[0]).toBe(WORKSPACE_ID)
		expect(handshakeProps()[0]).toMatchObject({
			handshakeMethod: 'initialize',
			outcome: 'ok',
			mcpEra: 'legacy',
			mcpProtocolVersion: 'none',
			client: 'claude_code',
			transport: 'http',
			authMethod: 'api_key',
			agentActorId: 'actor-42',
		})
		expect(captureMcpToolCall).not.toHaveBeenCalled()
		// clientInfo.name is free text and is never forwarded.
		expect(JSON.stringify(handshakeProps()[0])).not.toContain('free text')
	})

	it('emits no handshake for an ordinary tool call', async () => {
		respondWith(okResult(1))
		await post(await createApp(), toolCall(1, 'list_objects'))
		expect(captureMcpHandshake).not.toHaveBeenCalled()
	})

	it('records a server/discover the legacy server rejects as rejected_version', async () => {
		respondWith({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } })
		await post(await createApp(), discover(1), { 'MCP-Protocol-Version': '2026-07-28' })

		expect(captureMcpHandshake).toHaveBeenCalledTimes(1)
		expect(handshakeProps()[0]).toMatchObject({
			handshakeMethod: 'server_discover',
			outcome: 'rejected_version',
			mcpEra: 'modern',
			mcpProtocolVersion: '2026-07-28',
		})
	})

	it('records a transport-level unsupported-version refusal as rejected_version', async () => {
		respondWith({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32000, message: 'Bad Request: Unsupported protocol version: 2026-07-28' },
		})
		await post(await createApp(), discover(1), { 'MCP-Protocol-Version': '2026-07-28' })
		expect(handshakeProps()[0]).toMatchObject({ outcome: 'rejected_version' })
	})

	it('records any other failure as error', async () => {
		respondWith({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } })
		await post(await createApp(), initialize(1))
		expect(handshakeProps()[0]).toMatchObject({ outcome: 'error' })
	})

	it('still emits the handshake when the transport wrote no response at all', async () => {
		mockHandleRequest.mockImplementation(async () => {})
		await post(await createApp(), initialize(1))
		expect(handshakeProps()[0]).toMatchObject({ handshakeMethod: 'initialize', outcome: 'error' })
	})

	it('emits one handshake per handshake request in a batch', async () => {
		respondWith([okResult(1), okResult(2)])
		await post(await createApp(), [initialize(1), discover(2)])
		expect(handshakeProps().map((h) => h.handshakeMethod)).toEqual([
			'initialize',
			'server_discover',
		])
	})

	it('does not break the request when handshake capture throws', async () => {
		captureMcpHandshake.mockRejectedValue(new Error('posthog exploded'))
		respondWith({ jsonrpc: '2.0', id: 1, result: {} })
		await post(await createApp(), initialize(1))
		expect(mockHandleRequest).toHaveBeenCalledTimes(1)
	})

	// The misfire phase returns early when no response carries an error. The
	// handshake must not live behind that return.
	it('is emitted even though no response carries an error', async () => {
		respondWith({ jsonrpc: '2.0', id: 1, result: {} })
		await post(await createApp(), initialize(1))
		expect(captureMcpHandshake).toHaveBeenCalledTimes(1)
	})
})
