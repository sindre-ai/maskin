import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness shape as mcp-trace-emission.test.ts: the MCP SDK is stubbed, the
// limiter is real. Only Date and the interval timers are faked, so the route's
// setImmediate-based flushing keeps working while the clock stays under test
// control.
const { mockHandleRequest, MockTransport, mockCreateMcpServer } = vi.hoisted(() => {
	const mockConnect = vi.fn().mockResolvedValue(undefined)
	const mockHandleRequest = vi.fn()
	const MockTransport = vi.fn().mockImplementation(() => ({ handleRequest: mockHandleRequest }))
	const mockCreateMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
	return { mockConnect, mockHandleRequest, MockTransport, mockCreateMcpServer }
})

vi.mock('@maskin/mcp', () => ({
	createMcpServer: mockCreateMcpServer,
	READ_TOOL_NAMES: new Set(['get_objects', 'list_objects']),
}))
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

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent }))

const AGENT_A = '11111111-1111-4111-8111-111111111111'
const AGENT_B = '22222222-2222-4222-8222-222222222222'
const HUMAN = '33333333-3333-4333-8333-333333333333'

const ACTORS: Record<string, { actorId: string; type: string }> = {
	ank_a: { actorId: AGENT_A, type: 'agent' },
	ank_b: { actorId: AGENT_B, type: 'agent' },
	ank_human: { actorId: HUMAN, type: 'human' },
}
const validateApiKey = vi.fn()
vi.mock('@maskin/auth', () => ({
	validateApiKey,
	generateApiKey: vi.fn(),
	hashPassword: vi.fn(),
	verifyPassword: vi.fn(),
	authMiddleware: vi.fn(),
}))

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const RATE_ENV = [
	'MASKIN_MCP_RATE_LIMIT_MODE',
	'MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN',
	'MASKIN_MCP_RATE_LIMIT_HUMAN_PER_MIN',
	'MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN',
	'MASKIN_MCP_RATE_LIMIT_WRITE_COST',
	'MASKIN_MCP_RATE_LIMIT_EXEMPT_ACTOR_IDS',
] as const

function setEnv(values: Partial<Record<(typeof RATE_ENV)[number], string>>) {
	for (const name of RATE_ENV) delete process.env[name]
	for (const [name, value] of Object.entries(values)) process.env[name] = value
}

function createEnv(socketIp: string | undefined = '198.51.100.5') {
	const mockNodeRes = {
		writeHead: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		headersSent: false,
		setHeader: vi.fn(),
	}
	const mockNodeReq = { url: '/mcp', method: 'POST', socket: { remoteAddress: socketIp } }
	return { env: { incoming: mockNodeReq, outgoing: mockNodeRes } }
}

type TestEnv = { Variables: { db: unknown } }

async function loadRoute() {
	const mod = await import('../../routes/mcp')
	mod.__resetMcpActorCache()
	mod.__resetMcpTraceSeq()
	mod.__resetMcpRateLimit()
	return mod
}

async function createApp(mod: Awaited<ReturnType<typeof loadRoute>>) {
	const app = new Hono<TestEnv>()
	app.use('*', async (c, next) => {
		c.set('db', {})
		await next()
	})
	app.route('/mcp', mod.default)
	return app
}

interface PostOptions {
	key?: string | null
	headers?: Record<string, string>
	socketIp?: string
	raw?: string
}

async function post(app: Hono<TestEnv>, body: unknown, options: PostOptions = {}) {
	const { env } = createEnv(options.socketIp)
	const key = options.key === undefined ? 'ank_a' : options.key
	const res = await app.request(
		new Request('http://localhost/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(key ? { Authorization: `Bearer ${key}` } : {}),
				'X-Workspace-Id': WORKSPACE_ID,
				...options.headers,
			},
			body: options.raw ?? JSON.stringify(body),
		}),
		undefined,
		env,
	)
	// The trace emitter runs as a `void` promise after the route returns.
	for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
	return res
}

const toolCall = (id: number, name = 'get_objects') => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name, arguments: {} },
})

function respondOk() {
	mockHandleRequest.mockImplementation(async (_req: unknown, res: { end: (s: string) => void }) => {
		res.end(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: { content: [{ type: 'text', text: 'ok' }] },
			}),
		)
	})
}

function summaryEvents() {
	return capturePosthogEvent.mock.calls.filter((c) => c[0] === 'mcp_rate_limit_summary')
}

describe('POST /mcp rate limiter', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
		vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
		captureMcpToolCall.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		capturePosthogEvent.mockResolvedValue(undefined)
		validateApiKey.mockImplementation(async (_db: unknown, key: string) => ACTORS[key] ?? null)
		respondOk()
	})

	afterEach(async () => {
		const mod = await import('../../routes/mcp')
		mod.__resetMcpRateLimit()
		vi.useRealTimers()
		setEnv({})
	})

	describe('log-only', () => {
		it('never rejects, serves every call and counts would_reject', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'log-only', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '2' })
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 5; i++) {
				const res = await post(app, toolCall(i))
				expect(res.status).toBe(200)
			}
			expect(mockHandleRequest).toHaveBeenCalledTimes(5)

			vi.advanceTimersByTime(60_000)
			expect(summaryEvents()).toHaveLength(1)
			expect(summaryEvents()[0]?.[2]).toMatchObject({
				mode: 'log-only',
				agent_allowed: 2,
				agent_would_reject: 3,
				agent_rejected: 0,
				tool_calls: 5,
				top_actor_ids: [AGENT_A],
				top_actor_would_reject: [3],
			})
		})

		it('treats a missing or unrecognised mode as log-only', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforced', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1' })
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 3; i++) expect((await post(app, toolCall(i))).status).toBe(200)
			setEnv({ MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1' })
			await loadRoute()
			for (let i = 1; i <= 3; i++) expect((await post(app, toolCall(i))).status).toBe(200)
		})
	})

	describe('enforce', () => {
		beforeEach(() => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '3' })
		})

		it('returns 429 with Retry-After and a JSON-RPC error that echoes the id', async () => {
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 3; i++) expect((await post(app, toolCall(i))).status).toBe(200)
			expect(mockHandleRequest).toHaveBeenCalledTimes(3)
			mockCreateMcpServer.mockClear()
			validateApiKey.mockClear()
			captureMcpToolCall.mockClear()

			const res = await post(app, toolCall(7))
			expect(res.status).toBe(429)
			// 3 per minute: one token every 20 seconds.
			expect(res.headers.get('Retry-After')).toBe('20')
			expect(await res.json()).toEqual({
				jsonrpc: '2.0',
				id: 7,
				error: {
					code: -32029,
					message: 'Rate limit exceeded for this API key. Retry after 20 seconds.',
					data: { retry_after_seconds: 20, limit_per_minute: 3, class: 'agent' },
				},
			})
			// Cheap: no server build, no new key lookup (cached), no trace, no REST work.
			expect(mockCreateMcpServer).not.toHaveBeenCalled()
			expect(mockHandleRequest).toHaveBeenCalledTimes(3)
			expect(validateApiKey).not.toHaveBeenCalled()
			expect(captureMcpToolCall).not.toHaveBeenCalled()
			expect(recordMcpMisfire).not.toHaveBeenCalled()
		})

		it('lets the caller back in once the clock has refilled the bucket', async () => {
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 3; i++) await post(app, toolCall(i))
			expect((await post(app, toolCall(4))).status).toBe(429)
			vi.advanceTimersByTime(20_000)
			expect((await post(app, toolCall(5))).status).toBe(200)
		})

		it('charges a write more than a read', async () => {
			const app = await createApp(await loadRoute())
			expect((await post(app, toolCall(1, 'create_objects'))).status).toBe(200) // 3 of 3
			expect((await post(app, toolCall(2))).status).toBe(429)
		})

		it('answers a batch with one error per request that has an id', async () => {
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 3; i++) await post(app, toolCall(i))
			const res = await post(app, [
				toolCall(10),
				{ jsonrpc: '2.0', method: 'notifications/initialized' },
				toolCall(11),
			])
			expect(res.status).toBe(429)
			const body = (await res.json()) as Array<{ id: unknown; error: { code: number } }>
			expect(body.map((b) => b.id)).toEqual([10, 11])
			expect(body.every((b) => b.error.code === -32029)).toBe(true)
		})

		it('uses a null id for a request without one', async () => {
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 3; i++) await post(app, toolCall(i))
			const res = await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' })
			expect(res.status).toBe(429)
			expect(await res.json()).toMatchObject({ id: null })
		})

		it('gives a made-up session header no exemption', async () => {
			const app = await createApp(await loadRoute())
			const headers = { 'X-Maskin-Session-Id': '44444444-4444-4444-8444-444444444444' }
			for (let i = 1; i <= 3; i++) await post(app, toolCall(i), { headers })
			expect((await post(app, toolCall(4), { headers })).status).toBe(429)
		})

		it('exempts only actors on the env list', async () => {
			setEnv({
				MASKIN_MCP_RATE_LIMIT_MODE: 'enforce',
				MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1',
				MASKIN_MCP_RATE_LIMIT_EXEMPT_ACTOR_IDS: ` ${AGENT_A}, nonsense`,
			})
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 4; i++)
				expect((await post(app, toolCall(i), { key: 'ank_a' })).status).toBe(200)
			await post(app, toolCall(1), { key: 'ank_b' })
			expect((await post(app, toolCall(2), { key: 'ank_b' })).status).toBe(429)

			vi.advanceTimersByTime(60_000)
			expect(summaryEvents()[0]?.[2]).toMatchObject({ agent_exempt: 4 })
		})

		it('limits humans by their own limit', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_HUMAN_PER_MIN: '2' })
			const app = await createApp(await loadRoute())
			await post(app, toolCall(1), { key: 'ank_human' })
			await post(app, toolCall(2), { key: 'ank_human' })
			const res = await post(app, toolCall(3), { key: 'ank_human' })
			expect(res.status).toBe(429)
			expect(await res.json()).toMatchObject({
				error: { data: { class: 'human', limit_per_minute: 2 } },
			})
		})
	})

	describe('unauthenticated callers', () => {
		beforeEach(() => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN: '2' })
		})

		it('share one bucket and cannot drain an agent bucket', async () => {
			const app = await createApp(await loadRoute())
			expect((await post(app, toolCall(1), { key: null })).status).toBe(200)
			// A key that does not resolve is unknown too, and shares the bucket.
			expect((await post(app, toolCall(2), { key: 'ank_nobody' })).status).toBe(200)
			const res = await post(app, toolCall(3), { key: null })
			expect(res.status).toBe(429)
			expect(await res.json()).toMatchObject({ error: { data: { class: 'unknown' } } })
			// Agents are untouched.
			expect((await post(app, toolCall(4), { key: 'ank_a' })).status).toBe(200)
			expect((await post(app, toolCall(5), { key: 'ank_b' })).status).toBe(200)
		})

		it('are bucketed by the socket address, not a constant', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN: '1' })
			const app = await createApp(await loadRoute())
			const from = (socketIp: string, id: number, headers: Record<string, string> = {}) =>
				post(app, toolCall(id), { key: null, socketIp, headers })
			expect((await from('198.51.100.1', 1)).status).toBe(200)
			expect((await from('198.51.100.1', 2)).status).toBe(429)
			// A different socket address is a different caller. If the route read the
			// string 'unknown' instead, this would share the exhausted bucket.
			expect((await from('198.51.100.2', 3)).status).toBe(200)
			// X-Forwarded-For is only honoured from a trusted proxy; here it changes nothing.
			expect((await from('198.51.100.1', 4, { 'X-Forwarded-For': '203.0.113.9' })).status).toBe(429)
		})

		it('counts keys that did not resolve in the summary', async () => {
			const app = await createApp(await loadRoute())
			await post(app, toolCall(1), { key: null })
			await post(app, toolCall(2), { key: 'ank_nobody' })
			vi.advanceTimersByTime(60_000)
			expect(summaryEvents()[0]?.[2]).toMatchObject({ unknown_allowed: 2, unknown_with_key: 1 })
		})
	})

	describe('key lookup', () => {
		it('fails open on a database error, counts it and does not cache it', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_UNKNOWN_PER_MIN: '1' })
			const app = await createApp(await loadRoute())
			validateApiKey.mockRejectedValue(new Error('connection reset'))
			// Far more calls than the unknown bucket (1 per minute) allows: an error must
			// not drop agents into the strict unknown bucket.
			for (let i = 1; i <= 4; i++) expect((await post(app, toolCall(i))).status).toBe(200)
			expect(validateApiKey).toHaveBeenCalledTimes(4)

			vi.advanceTimersByTime(60_000)
			expect(summaryEvents()[0]?.[2]).toMatchObject({ unknown_lookup_error: 4, unknown_allowed: 0 })

			// The database is back: the key resolves and is judged as the agent it is.
			validateApiKey.mockImplementation(async (_db: unknown, key: string) => ACTORS[key] ?? null)
			expect((await post(app, toolCall(5))).status).toBe(200)
			expect(validateApiKey).toHaveBeenCalledTimes(5)
		})
	})

	describe('everything else on the route', () => {
		it('still answers invalid JSON with 400, even with an empty bucket', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1' })
			const app = await createApp(await loadRoute())
			await post(app, toolCall(1))
			const res = await post(app, null, { raw: '{not json' })
			expect(res.status).toBe(400)
		})

		it('does not limit GET and DELETE, which stay 405', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1' })
			const app = await createApp(await loadRoute())
			await post(app, toolCall(1))
			expect((await app.request('http://localhost/mcp', { method: 'GET' })).status).toBe(405)
			expect((await app.request('http://localhost/mcp', { method: 'DELETE' })).status).toBe(405)
		})

		it('off bypasses the limiter: no accounting, no summary', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'off', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '1' })
			const app = await createApp(await loadRoute())
			for (let i = 1; i <= 4; i++) expect((await post(app, toolCall(i))).status).toBe(200)
			vi.advanceTimersByTime(5 * 60_000)
			expect(summaryEvents()).toHaveLength(0)
			expect(vi.getTimerCount()).toBe(0)
		})

		it('still emits trace and misfire events for allowed calls', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'enforce', MASKIN_MCP_RATE_LIMIT_AGENT_PER_MIN: '600' })
			const app = await createApp(await loadRoute())
			mockHandleRequest.mockImplementation(
				async (_req: unknown, res: { end: (s: string) => void }) => {
					res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							id: 1,
							result: {
								isError: true,
								content: [
									{
										type: 'text',
										text: 'MCP error -32602: Invalid arguments for tool get_objects',
									},
								],
							},
						}),
					)
				},
			)
			await post(app, toolCall(1))
			expect(captureMcpToolCall).toHaveBeenCalledTimes(1)
			expect(captureMcpToolCall.mock.calls[0]?.[1]).toMatchObject({
				toolName: 'get_objects',
				agentActorId: AGENT_A,
			})
			expect(recordMcpMisfire).toHaveBeenCalledTimes(1)
		})
	})

	describe('summary', () => {
		it('emits one log line and one PostHog event with the same payload, only with traffic', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'log-only' })
			const mod = await loadRoute()
			const { logger } = await import('../../lib/logger')
			const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
			const app = await createApp(mod)

			await post(app, toolCall(1))
			vi.advanceTimersByTime(60_000)
			const lines = info.mock.calls.filter((c) => c[0] === 'mcp_rate_limit_summary')
			expect(lines).toHaveLength(1)
			expect(summaryEvents()).toHaveLength(1)
			expect(summaryEvents()[0]?.[2]).toEqual(lines[0]?.[1])
			expect(summaryEvents()[0]?.[2]).toMatchObject({ mode: 'log-only', agent_allowed: 1 })

			// A quiet minute says nothing.
			vi.advanceTimersByTime(60_000)
			expect(summaryEvents()).toHaveLength(1)
			info.mockRestore()
		})

		it('logs the resolved config once and never an actor id', async () => {
			setEnv({
				MASKIN_MCP_RATE_LIMIT_MODE: 'enforce',
				MASKIN_MCP_RATE_LIMIT_EXEMPT_ACTOR_IDS: AGENT_B,
			})
			const mod = await loadRoute()
			const { logger } = await import('../../lib/logger')
			const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
			const app = await createApp(mod)
			await post(app, toolCall(1))
			await post(app, toolCall(2))
			const boot = info.mock.calls.filter((c) => c[0] === 'mcp_rate_limit_config')
			expect(boot).toHaveLength(1)
			expect(boot[0]?.[1]).toMatchObject({
				mode: 'enforce',
				agent_per_min: 600,
				exempt_actor_count: 1,
			})
			expect(JSON.stringify(boot[0])).not.toContain(AGENT_B)
			info.mockRestore()
		})

		it('runs an unref-ed interval and leaves no timer after shutdown', async () => {
			setEnv({ MASKIN_MCP_RATE_LIMIT_MODE: 'log-only' })
			const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
			const mod = await loadRoute()
			mod.initMcpRateLimit()
			expect(setIntervalSpy).toHaveBeenCalledTimes(1)
			const timer = setIntervalSpy.mock.results[0]?.value as { hasRef: () => boolean }
			expect(timer.hasRef()).toBe(false)
			expect(vi.getTimerCount()).toBe(1)

			mod.stopMcpRateLimit()
			expect(vi.getTimerCount()).toBe(0)
			setIntervalSpy.mockRestore()
		})
	})
})
