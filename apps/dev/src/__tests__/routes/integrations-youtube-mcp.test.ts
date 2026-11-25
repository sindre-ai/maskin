import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceWriter: vi.fn(async () => true),
}))

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: class {
		async handleRequest() {
			// no-op: the test asserts the route mounts and auth-gates, not the JSON-RPC handshake.
		}
	},
}))

vi.mock('../../lib/integrations/providers/youtube/mcp-server', () => ({
	createYoutubeMcpServer: vi.fn(() => ({
		connect: vi.fn(async () => undefined),
	})),
}))

vi.mock('../../lib/integrations/tool-gate', () => ({
	toolGateFor: vi.fn(async () => undefined),
}))

import { createYoutubeMcpServer } from '../../lib/integrations/providers/youtube/mcp-server'
import { isWorkspaceWriter } from '../../lib/workspace-auth'
import youtubeMcpRoutes from '../../routes/integrations-youtube-mcp'

const ACTOR = '11111111-1111-1111-1111-111111111111'
const WORKSPACE = '22222222-2222-2222-2222-222222222222'

function chainableDb(rows: unknown[]) {
	const chain: Record<string, unknown> = {}
	for (const m of ['select', 'from', 'where']) chain[m] = () => chain
	chain.limit = async () => rows
	return chain
}

// The Node server puts the raw request and response on c.env; app.request has none unless given.
const nodeEnv = { incoming: {}, outgoing: {} }

function mountedApp(db: unknown = chainableDb([])) {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db', db as never)
		c.set('actorId', ACTOR)
		await next()
	})
	app.route('/api/integrations/youtube/mcp', youtubeMcpRoutes)
	return app
}

const post = (headers: Record<string, string> = {}) => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json', ...headers },
	body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
})

beforeEach(() => {
	vi.clearAllMocks()
	;(isWorkspaceWriter as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
})

describe('POST /api/integrations/youtube/mcp', () => {
	it('400s when X-Workspace-Id header is missing', async () => {
		const res = await mountedApp().request('/api/integrations/youtube/mcp', post())
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error?.code).toBe('BAD_REQUEST')
	})

	it('403s when the actor is not a member of the workspace', async () => {
		;(isWorkspaceWriter as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
		const res = await mountedApp().request(
			'/api/integrations/youtube/mcp',
			post({ 'X-Workspace-Id': WORKSPACE }),
		)
		expect(res.status).toBe(403)
	})

	it('builds the tool server for the caller, even with no connected integration', async () => {
		const db = chainableDb([])
		const res = await mountedApp(db).request(
			'/api/integrations/youtube/mcp',
			post({ 'X-Workspace-Id': WORKSPACE }),
			nodeEnv,
		)
		// The mocked transport never writes, so the route answers its sentinel response.
		expect(res.status).toBe(200)
		expect(createYoutubeMcpServer).toHaveBeenCalledWith(
			{ db, workspaceId: WORKSPACE, actorId: ACTOR },
			undefined,
		)
	})

	it('400s on a body that is not JSON', async () => {
		const res = await mountedApp().request(
			'/api/integrations/youtube/mcp',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': WORKSPACE },
				body: 'not json',
			},
			nodeEnv,
		)
		expect(res.status).toBe(400)
	})
})

describe('GET / DELETE /api/integrations/youtube/mcp', () => {
	it('answers 405 to GET and DELETE', async () => {
		const app = mountedApp()
		expect((await app.request('/api/integrations/youtube/mcp', { method: 'GET' })).status).toBe(405)
		expect((await app.request('/api/integrations/youtube/mcp', { method: 'DELETE' })).status).toBe(
			405,
		)
	})
})
