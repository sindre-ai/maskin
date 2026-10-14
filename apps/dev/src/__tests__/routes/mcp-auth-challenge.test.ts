import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The sign-in challenge on POST /mcp, through the real route. Only the edges are stubbed: the MCP
// SDK transport, the Claude token lookup and PostHog capture. The db handed to the route throws on
// any property access, so a case that must not touch the database fails loudly if it does.
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

// The kill switch is read from the environment by the real isMcpOAuthEnabled; only the token
// lookup is replaced.
const resolveMcpCredential = vi.fn()
vi.mock('@maskin/auth/mcp', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@maskin/auth/mcp')>()
	return { ...actual, resolveMcpCredential }
})

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const OAUTH_TOKEN = 'mat_0123456789abcdef0123456789abcdef0123456789a'
const CHALLENGE =
	'Bearer resource_metadata="https://maskin.io/.well-known/oauth-protected-resource/mcp", scope="mcp"'
const BODY_401 = {
	jsonrpc: '2.0',
	error: { code: -32001, message: 'Authentication required' },
	id: null,
}

const forbiddenDb = new Proxy(
	{},
	{
		get() {
			throw new Error('database touched')
		},
	},
)

type TestEnv = { Variables: { db: unknown } }

async function createApp() {
	const app = new Hono<TestEnv>()
	app.use('*', async (c, next) => {
		c.set('db', forbiddenDb)
		await next()
	})
	const mod = await import('../../routes/mcp')
	app.route('/mcp', mod.default)
	mod.__resetMcpActorCache()
	mod.__resetMcpTraceSeq()
	return app
}

async function post(app: Hono<TestEnv>, headers: Record<string, string>) {
	mockHandleRequest.mockImplementation(async (_req: unknown, res: { end: (s: string) => void }) => {
		res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }))
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
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		}),
		undefined,
		env,
	)
	// The emitter runs as a `void` promise after the route returns.
	for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r))
	return res
}

describe('POST /mcp sign-in challenge', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		vi.stubEnv('MASKIN_OAUTH_ISSUER', '')
		vi.stubEnv('WEB_APP_URL', '')
		vi.stubEnv('FRONTEND_URL', '')
		capturePosthogEvent.mockResolvedValue(undefined)
		recordMcpMisfire.mockResolvedValue(undefined)
		validateApiKey.mockResolvedValue(null)
		resolveMcpCredential.mockResolvedValue(null)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('switch on', () => {
		it.each([
			['no Authorization header', {}],
			['a non-Bearer header', { Authorization: 'Basic dXNlcjpwYXNz' }],
			['an empty bearer', { Authorization: 'Bearer ' }],
			['a blank bearer', { Authorization: 'Bearer    ' }],
		])(
			'answers %s with the 401 challenge and never touches the database',
			async (_name, headers) => {
				const res = await post(await createApp(), headers)

				expect(res.status).toBe(401)
				expect(res.headers.get('WWW-Authenticate')).toBe(CHALLENGE)
				expect(await res.json()).toEqual(BODY_401)
				expect(mockCreateMcpServer).not.toHaveBeenCalled()
				expect(resolveMcpCredential).not.toHaveBeenCalled()
				expect(validateApiKey).not.toHaveBeenCalled()
			},
		)

		it('answers an invalid mat_ token with 401 and error="invalid_token" added', async () => {
			resolveMcpCredential.mockResolvedValue(null)

			const res = await post(await createApp(), { Authorization: `Bearer ${OAUTH_TOKEN}` })

			expect(res.status).toBe(401)
			const header = res.headers.get('WWW-Authenticate') ?? ''
			expect(header).toContain('error="invalid_token"')
			expect(header).toContain(
				'resource_metadata="https://maskin.io/.well-known/oauth-protected-resource/mcp"',
			)
			expect(header.endsWith('scope="mcp"')).toBe(true)
			expect(await res.json()).toEqual(BODY_401)
			expect(mockCreateMcpServer).not.toHaveBeenCalled()
			expect(resolveMcpCredential).toHaveBeenCalledWith(forbiddenDb, OAUTH_TOKEN)
		})

		it('lets a valid mat_ token through to the transport', async () => {
			resolveMcpCredential.mockResolvedValue({ kind: 'oauth', actorId: 'person-7' })

			const res = await post(await createApp(), { Authorization: `Bearer ${OAUTH_TOKEN}` })

			expect(res.status).not.toBe(401)
			expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
			expect(mockHandleRequest).toHaveBeenCalledTimes(1)
		})

		it('leaves an invalid ank_ key exactly as before: it reaches the transport', async () => {
			validateApiKey.mockResolvedValue(null)

			const res = await post(await createApp(), { Authorization: 'Bearer ank_revoked_key' })

			expect(res.status).not.toBe(401)
			expect(res.headers.get('WWW-Authenticate')).toBeNull()
			expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
			expect(mockHandleRequest).toHaveBeenCalledTimes(1)
		})

		it('lets a valid ank_ key through', async () => {
			validateApiKey.mockResolvedValue({ actorId: 'actor-42', type: 'human' })

			const res = await post(await createApp(), {
				Authorization: 'Bearer ank_0123456789abcdef0123456789abcdef',
			})

			expect(res.status).not.toBe(401)
			expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
			expect(mockCreateMcpServer.mock.calls[0][0]).toMatchObject({
				apiKey: 'ank_0123456789abcdef0123456789abcdef',
			})
		})

		it('leaves any other bearer string alone', async () => {
			const res = await post(await createApp(), { Authorization: 'Bearer something-else' })

			expect(res.status).not.toBe(401)
			expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
		})

		it('builds the challenge from the configured origin', async () => {
			vi.stubEnv('MASKIN_OAUTH_ISSUER', 'http://localhost:3000')

			const res = await post(await createApp(), {})

			expect(res.headers.get('WWW-Authenticate')).toBe(
				'Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp", scope="mcp"',
			)
		})

		it('keeps GET and DELETE a bare 405', async () => {
			const app = await createApp()
			for (const method of ['GET', 'DELETE']) {
				const res = await app.request(new Request('http://localhost/mcp', { method }))
				expect(res.status).toBe(405)
				expect(await res.text()).toBe('Method Not Allowed')
			}
		})
	})

	describe('switch off', () => {
		beforeEach(() => {
			vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		})

		it.each([
			['no Authorization header', {}],
			['a non-Bearer header', { Authorization: 'Basic dXNlcjpwYXNz' }],
			['an empty bearer', { Authorization: 'Bearer ' }],
			['a mat_ token', { Authorization: `Bearer ${OAUTH_TOKEN}` }],
			['an invalid ank_ key', { Authorization: 'Bearer ank_revoked_key' }],
		])(
			'behaves as before for %s: no challenge, request reaches the transport',
			async (_name, headers) => {
				const res = await post(await createApp(), headers)

				expect(res.status).not.toBe(401)
				expect(res.headers.get('WWW-Authenticate')).toBeNull()
				expect(mockCreateMcpServer).toHaveBeenCalledTimes(1)
				expect(mockHandleRequest).toHaveBeenCalledTimes(1)
			},
		)
	})
})
