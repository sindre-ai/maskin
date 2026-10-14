import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A Claude connector token (mat_) on POST /mcp: the telemetry label says oauth with the
// client from the grant, and the in-process MCP server is handed the forward marker that
// lets the API accept the token. Same harness as mcp-key-traffic-baseline.test.ts; only the
// edges are stubbed (MCP transport, the credential lookup, PostHog capture).
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

const resolveMcpCredential = vi.fn()
vi.mock('@maskin/auth/mcp', () => ({
	resolveMcpCredential,
	isMcpOAuthEnabled: () => false,
	getMcpForwardMarker: () => 'test-forward-marker',
}))

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PERSON_ID = 'person-7'
const OAUTH_TOKEN = 'mat_0123456789abcdef0123456789abcdef0123456789a'

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
	await app.request(
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
}

function toolCallProps(): Record<string, unknown> | undefined {
	return capturePosthogEvent.mock.calls.find((c) => c[0] === 'mcp_tool_call')?.[2]
}

describe('POST /mcp with a Claude connector token', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		capturePosthogEvent.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		resolveMcpCredential.mockResolvedValue({
			kind: 'oauth',
			actorId: PERSON_ID,
			actorType: 'human',
			workspaceId: WORKSPACE_ID,
			grantId: 'grant-1',
			clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
		})
	})

	it('labels the call oauth, with the client from the grant and the person behind the token', async () => {
		await callTool(await createApp(), { Authorization: `Bearer ${OAUTH_TOKEN}` })

		expect(toolCallProps()).toMatchObject({
			agent_actor_id: PERSON_ID,
			auth_method: 'oauth',
			client: 'claude_ai',
			actor_type: 'human',
		})
	})

	it('puts no token, grant id or client URL in any property', async () => {
		await callTool(await createApp(), { Authorization: `Bearer ${OAUTH_TOKEN}` })

		const serialized = JSON.stringify(toolCallProps())
		for (const forbidden of [OAUTH_TOKEN, 'grant-1', 'mcp-oauth-client-metadata']) {
			expect(serialized).not.toContain(forbidden)
		}
		expect(serialized).not.toMatch(/mat_[A-Za-z0-9_-]{20,}/)
	})

	it('hands the in-process MCP server the forward marker for a token, and not for an API key', async () => {
		const app = await createApp()
		await callTool(app, { Authorization: `Bearer ${OAUTH_TOKEN}` })
		expect(mockCreateMcpServer.mock.calls[0][0]).toMatchObject({
			apiKey: OAUTH_TOKEN,
			forwardMarker: 'test-forward-marker',
		})

		mockCreateMcpServer.mockClear()
		validateApiKey.mockResolvedValue({ actorId: 'actor-1', type: 'agent' })
		await callTool(app, { Authorization: 'Bearer ank_0123456789abcdef' })
		expect(mockCreateMcpServer.mock.calls[0][0].forwardMarker).toBeUndefined()
	})

	it('reports a token that does not resolve as an unknown caller', async () => {
		resolveMcpCredential.mockResolvedValue(null)

		await callTool(await createApp(), { Authorization: `Bearer ${OAUTH_TOKEN}` })

		expect(toolCallProps()).toMatchObject({
			agent_actor_id: null,
			auth_method: null,
			actor_type: null,
		})
	})
})
