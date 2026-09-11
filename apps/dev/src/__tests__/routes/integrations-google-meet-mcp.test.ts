import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn(async () => true),
}))

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: class {
		async handleRequest() {
			// no-op — the test asserts the route mounts + auth-gates, not the
			// full JSON-RPC handshake (covered by the LinkedIn/Slack MCP
			// integration tests when the two MCP surfaces graduate to shared
			// helper coverage).
		}
	},
}))

vi.mock('../../lib/integrations/providers/google-meet/mcp-server', () => ({
	createGoogleMeetMcpServer: vi.fn(() => ({
		connect: vi.fn(async () => undefined),
	})),
}))

import { isWorkspaceMember } from '../../lib/workspace-auth'

import googleMeetMcpRoutes from '../../routes/integrations-google-meet-mcp'

function mountedApp() {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db', {} as never)
		c.set('actorId', '11111111-1111-1111-1111-111111111111')
		await next()
	})
	app.route('/api/integrations/google-meet/mcp', googleMeetMcpRoutes)
	return app
}

beforeEach(() => {
	vi.clearAllMocks()
	;(isWorkspaceMember as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
})

describe('POST /api/integrations/google-meet/mcp', () => {
	it('400s when X-Workspace-Id header is missing', async () => {
		const app = mountedApp()
		const res = await app.request('/api/integrations/google-meet/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error?.code).toBe('BAD_REQUEST')
	})

	it('403s when the actor is not a member of the workspace', async () => {
		;(isWorkspaceMember as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
		const app = mountedApp()
		const res = await app.request('/api/integrations/google-meet/mcp', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': '22222222-2222-2222-2222-222222222222',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
		})
		expect(res.status).toBe(403)
	})

})

describe('GET / DELETE /api/integrations/google-meet/mcp', () => {
	it('rejects GET with 405 Method Not Allowed (matches LinkedIn/Slack surface)', async () => {
		const app = mountedApp()
		const res = await app.request('/api/integrations/google-meet/mcp', { method: 'GET' })
		expect(res.status).toBe(405)
	})

	it('rejects DELETE with 405', async () => {
		const app = mountedApp()
		const res = await app.request('/api/integrations/google-meet/mcp', { method: 'DELETE' })
		expect(res.status).toBe(405)
	})
})
