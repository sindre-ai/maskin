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

	it('does not attribute the batch response size to each call in the batch', async () => {
		// A batch writes ONE response body. Stamping its length onto each of the
		// N traces would inflate any sum or average of `response_bytes` by ~N×,
		// in the direction that makes tools look fatter than they are. Null is
		// the honest answer for a measurement that isn't per-call.
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
		expect(traces().map((t) => t.responseBytes)).toEqual([null, null])
	})

	it('attributes duration and response size on a single-call request', async () => {
		// The negative assertions above pass just as happily against an
		// always-null regression, so pin the positive case too.
		mockHandleRequest.mockImplementation(
			async (_req: unknown, res: { end: (s: string) => void }) => {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }))
			},
		)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})
		const trace = traces()[0]
		expect(typeof trace?.durationMs).toBe('number')
		expect(trace?.responseBytes).toBeGreaterThan(0)
	})

	it('excludes the actor lookup from duration_ms', async () => {
		// `duration_ms` must measure the tool call, not our own actor-cache
		// miss. The lookup is awaited inside the emitter; if the clock were read
		// there rather than in the request handler's `finally`, a slow lookup
		// would be billed to the tool and every tool would show a bimodal
		// latency distribution that is really just cache behaviour.
		let resolveSlowLookup: ((v: unknown) => void) | undefined
		validateApiKey.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSlowLookup = resolve
				}),
		)
		respondOk(1)
		const app = await createApp()

		const call = post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})
		// Hold the actor lookup open well past any plausible tool-call time.
		await new Promise((r) => setTimeout(r, 80))
		resolveSlowLookup?.({ actorId: 'actor-42', type: 'agent' })
		await call
		// `post` drained its ticks while the lookup was still blocked, so let
		// the emitter finish now that it has resolved.
		for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))

		expect(traces()[0]?.durationMs).toBeLessThan(80)
	})
})

// ── Regression: the four critical review findings ───────────────────────

describe('session id validation', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	// The preset header is `${SESSION_ID}`, expanded by agent-run.sh's envsubst.
	// A client that skips that pass sends the literal text; accepting it would
	// merge every such caller into one bucket wearing the `maskin-session` tag,
	// which is the label meaning "this is a real sessions.id".
	it('rejects an unexpanded ${...} placeholder rather than trusting it', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': '${SESSION_ID}',
		})

		const trace = traces()[0]
		expect(trace?.sessionSource).toBe('unknown')
		expect(trace?.sessionId).not.toBe('${SESSION_ID}')
		expect(String(trace?.sessionId)).toMatch(/^anon-/)
	})

	it('falls through to the next header when the first is a placeholder', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': '${SESSION_ID}',
			'Mcp-Session-Id': 'real-external-id',
		})

		expect(traces()[0]).toMatchObject({
			sessionId: 'real-external-id',
			sessionSource: 'mcp-session',
		})
	})

	it('rejects an over-long session id', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': 'a'.repeat(129),
		})

		expect(traces()[0]?.sessionSource).toBe('unknown')
	})

	it('still accepts a session id at exactly the cap', async () => {
		respondOk(1)
		const app = await createApp()
		const id = 'a'.repeat(128)
		await post(app, toolCall(1, 'list_objects', {}), { 'X-Maskin-Session-Id': id })

		// Kept — a value at the cap is not dropped. But it is not uuid-shaped,
		// so it cannot claim `maskin-session`; see the next two cases.
		expect(traces()[0]).toMatchObject({ sessionId: id, sessionSource: 'mcp-session' })
	})

	it('labels a uuid-shaped X-Maskin-Session-Id as a real session', async () => {
		respondOk(1)
		const app = await createApp()
		const id = '3f3726b1-0000-4000-8000-000000000001'
		await post(app, toolCall(1, 'list_objects', {}), { 'X-Maskin-Session-Id': id })

		expect(traces()[0]).toMatchObject({ sessionId: id, sessionSource: 'maskin-session' })
	})

	it('downgrades a non-uuid X-Maskin-Session-Id instead of trusting the label', async () => {
		respondOk(1)
		const app = await createApp()
		// `maskin-session` means "this IS a sessions.id and joins back to that
		// row". `/mcp` is mounted outside authMiddleware, so an arbitrary header
		// value must not be able to claim it — the value is still usable for
		// grouping, so keep it and downgrade rather than discard.
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': 'not-a-uuid',
		})

		expect(traces()[0]).toMatchObject({
			sessionId: 'not-a-uuid',
			sessionSource: 'mcp-session',
		})
	})
})

describe('transport failure', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	it('still emits a trace when handleRequest throws, rather than spending a seq on nothing', async () => {
		const app = await createApp()
		respondOk(1)
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})

		// Second call blows up inside the transport. Its sequence number was
		// already spent before the throw, so without a `finally` the event would
		// simply never be emitted — and the resulting gaps in `seq` would line up
		// exactly with the failures this event exists to surface.
		mockHandleRequest.mockRejectedValueOnce(new Error('transport exploded'))
		await post(app, toolCall(2, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})

		expect(traces()).toHaveLength(2)
		expect(traces()[1]).toMatchObject({
			seq: 2,
			ok: false,
			errorClass: 'no-response',
		})
	})
})

describe('seq key isolation', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	it('does not share a counter between workspaces using the same session id', async () => {
		const app = await createApp()
		// Same client-chosen `Mcp-Session-Id` from two unrelated callers. Keyed
		// on the id alone they would interleave into one sequence, and each
		// caller would see a run with half its numbers missing and no duplicates
		// to reveal the collision.
		respondOk(1)
		await post(app, toolCall(1, 'list_objects', {}), {
			'Mcp-Session-Id': '1',
			'X-Workspace-Id': 'workspace-a',
		})
		respondOk(2)
		await post(app, toolCall(2, 'list_objects', {}), {
			'Mcp-Session-Id': '1',
			'X-Workspace-Id': 'workspace-b',
		})

		expect(traces().map((t) => t.seq)).toEqual([1, 1])
	})

	it('does not let an mcp-session id land on a maskin-session counter', async () => {
		const app = await createApp()
		const id = '3f3726b1-0000-4000-8000-000000000002'
		respondOk(1)
		await post(app, toolCall(1, 'list_objects', {}), { 'X-Maskin-Session-Id': id })
		respondOk(2)
		await post(app, toolCall(2, 'list_objects', {}), { 'Mcp-Session-Id': id })

		expect(traces().map((t) => t.seq)).toEqual([1, 1])
	})
})

describe('seq allocation', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	// An unidentified caller's id is minted per request and never recurs, so a
	// counter slot spent on it could only ever hold 1 — while occupying that
	// slot for the full TTL. `/mcp` is unauthenticated, so letting those calls
	// consume slots lets anonymous traffic evict live sessions, which then
	// silently restart at 1.
	it('does not number, or track, a call from an unidentified caller', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}))
		await post(app, toolCall(1, 'list_objects', {}))

		expect(traces().map((t) => t.seq)).toEqual([null, null])
		const mod = await import('../../routes/mcp')
		expect(mod.__mcpTraceSeqSize()).toBe(0)
	})

	it('still numbers identified callers while anonymous traffic flows', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'a', {}), { 'X-Maskin-Session-Id': MASKIN_SESSION_ID })
		await post(app, toolCall(1, 'b', {}))
		await post(app, toolCall(1, 'c', {}), { 'X-Maskin-Session-Id': MASKIN_SESSION_ID })

		expect(traces().map((t) => t.seq)).toEqual([1, null, 2])
	})
})

describe('unpaired tool calls', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'agent' })
	})

	// `ok: !error` alone reads "no response found" as "no error found", so a
	// transport-level rejection would be recorded as a success in the very
	// event that exists to surface failures.
	it('records a call with no matching response as a failure, not a success', async () => {
		// Responds under a different id, so the call cannot be paired.
		mockHandleRequest.mockImplementation(
			async (_req: unknown, res: { end: (s: string) => void }) => {
				res.end(JSON.stringify({ jsonrpc: '2.0', id: 999, result: { content: [] } }))
			},
		)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})

		expect(traces()[0]).toMatchObject({ ok: false, errorClass: 'no-response' })
	})

	it('keeps a genuinely successful call marked ok', async () => {
		respondOk(1)
		const app = await createApp()
		await post(app, toolCall(1, 'list_objects', {}), {
			'X-Maskin-Session-Id': MASKIN_SESSION_ID,
		})

		expect(traces()[0]).toMatchObject({ ok: true, errorClass: null })
	})
})
