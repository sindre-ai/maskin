import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Key-traffic baseline: a real POST /mcp with an API key, through the real
// route, the real emitter and the real captureMcpToolCall. Only the edges are
// stubbed: the MCP SDK transport (so the route sees a JSON-RPC body we control,
// same harness as mcp-trace-emission.test.ts), the key lookup, and PostHog
// capture, whose arguments are what this test asserts on.
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

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent }))

const recordMcpMisfire = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/mcp-misfire', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-misfire')>()
	return { ...actual, recordMcpMisfire }
})

const validateApiKey = vi.fn()
vi.mock('@maskin/auth', () => ({
	validateApiKey,
	generateApiKey: vi.fn(),
	hashPassword: vi.fn(),
	verifyPassword: vi.fn(),
	authMiddleware: vi.fn(),
}))

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const ACTOR_ID = 'actor-42'
const API_KEY = 'ank_0123456789abcdef0123456789abcdef'
const RAW_USER_AGENT = 'claude-cli/2.0.14 (external, cli) build-7f3a9c'

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

async function callTool(app: Hono<TestEnv>, headers: Record<string, string>) {
	mockHandleRequest.mockImplementation(async (_req: unknown, res: { end: (s: string) => void }) => {
		res.end(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: { content: [{ type: 'text', text: 'ok' }] },
			}),
		)
	})
	const env = {
		incoming: { url: '/mcp', method: 'POST' },
		outgoing: {
			writeHead: vi.fn(),
			write: vi.fn(),
			end: vi.fn(),
			headersSent: false,
			setHeader: vi.fn(),
		},
	}
	const res = await app.request(
		new Request('http://localhost/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': WORKSPACE_ID, ...headers },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'list_objects', arguments: { type: 'bet' } },
			}),
		}),
		undefined,
		env,
	)
	// The emitter runs as a `void` promise after the route returns.
	for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
	return res
}

/** The PostHog calls for mcp_tool_call, as [distinctId, props]. */
function toolCallEvents(): Array<[string, Record<string, unknown>]> {
	return capturePosthogEvent.mock.calls
		.filter((c) => c[0] === 'mcp_tool_call')
		.map((c) => [c[1] as string, c[2] as Record<string, unknown>])
}

describe('key-traffic baseline on POST /mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturePosthogEvent.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue({ actorId: ACTOR_ID, type: 'agent' })
	})

	it('sends auth_method, client and actor_type to PostHog for a keyed call', async () => {
		const app = await createApp()
		await callTool(app, { Authorization: `Bearer ${API_KEY}`, 'User-Agent': RAW_USER_AGENT })

		const events = toolCallEvents()
		expect(events).toHaveLength(1)
		const [distinctId, props] = events[0] as [string, Record<string, unknown>]
		// Distinct id is unchanged, so existing dashboards keep working.
		expect(distinctId).toBe(ACTOR_ID)
		expect(props).toMatchObject({
			workspace_id: WORKSPACE_ID,
			agent_actor_id: ACTOR_ID,
			tool_name: 'list_objects',
			transport: 'http',
			auth_method: 'api_key',
			client: 'claude_code',
			actor_type: 'agent',
		})
	})

	it('puts no raw User-Agent, key, token or key prefix in any property', async () => {
		const app = await createApp()
		await callTool(app, { Authorization: `Bearer ${API_KEY}`, 'User-Agent': RAW_USER_AGENT })

		const serialized = JSON.stringify(toolCallEvents()[0])
		for (const forbidden of [RAW_USER_AGENT, 'build-7f3a9c', 'claude-cli', API_KEY, 'ank_']) {
			expect(serialized).not.toContain(forbidden)
		}
		expect(serialized).not.toContain('Bearer')
	})

	it('reports null auth_method and actor_type, and the workspace as distinct id, for a bad key', async () => {
		validateApiKey.mockResolvedValue(null)
		const app = await createApp()
		await callTool(app, { Authorization: 'Bearer ank_revoked_key', 'User-Agent': 'curl/8.4.0' })

		const [distinctId, props] = toolCallEvents()[0] as [string, Record<string, unknown>]
		expect(distinctId).toBe(WORKSPACE_ID)
		expect(props).toMatchObject({
			agent_actor_id: null,
			auth_method: null,
			actor_type: null,
			client: 'other',
		})
	})

	it('reports null auth_method when no Authorization header is sent', async () => {
		const app = await createApp()
		await callTool(app, {})

		expect(validateApiKey).not.toHaveBeenCalled()
		expect(toolCallEvents()[0]?.[1]).toMatchObject({
			agent_actor_id: null,
			auth_method: null,
			actor_type: null,
		})
	})
})
