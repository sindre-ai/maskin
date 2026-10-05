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
			// no-op: this file asserts the route mounts and gates on workspace
			// membership; the JSON-RPC surface is covered by the server contract test.
		}
	},
}))

vi.mock('../../lib/integrations/providers/google-drive/mcp-server', () => ({
	createGoogleDriveMcpServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) })),
}))

import { createGoogleDriveMcpServer } from '../../lib/integrations/providers/google-drive/mcp-server'
import { isWorkspaceMember } from '../../lib/workspace-auth'
import googleDriveMcpRoutes from '../../routes/integrations-google-drive-mcp'

const PATH = '/api/integrations/google-drive/mcp'
const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })

function mountedApp() {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db', {} as never)
		c.set('actorId', '11111111-1111-1111-1111-111111111111')
		await next()
	})
	app.route(PATH, googleDriveMcpRoutes)
	return app
}

beforeEach(() => {
	vi.clearAllMocks()
	;(isWorkspaceMember as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
})

describe('POST /api/integrations/google-drive/mcp', () => {
	it('400s when X-Workspace-Id is missing', async () => {
		const res = await mountedApp().request(PATH, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: rpc,
		})
		expect(res.status).toBe(400)
		expect((await res.json()).error?.code).toBe('BAD_REQUEST')
	})

	it('403s when the actor is not a member of the workspace, and builds no server', async () => {
		;(isWorkspaceMember as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
		const res = await mountedApp().request(PATH, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': '22222222-2222-2222-2222-222222222222',
			},
			body: rpc,
		})
		expect(res.status).toBe(403)
		expect(createGoogleDriveMcpServer).not.toHaveBeenCalled()
	})

	it('binds the server to the requested workspace, the caller actor and the session header', async () => {
		await mountedApp().request(
			PATH,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Workspace-Id': '22222222-2222-2222-2222-222222222222',
					'X-Maskin-Session-Id': 'sess-1',
				},
				body: rpc,
			},
			// The Node req/res the route hands to the (mocked) transport.
			{ outgoing: {}, incoming: {} },
		)
		expect(createGoogleDriveMcpServer).toHaveBeenCalledWith({
			db: {},
			workspaceId: '22222222-2222-2222-2222-222222222222',
			actorId: '11111111-1111-1111-1111-111111111111',
			sessionId: 'sess-1',
		})
	})

	it('rejects GET and DELETE with 405', async () => {
		const app = mountedApp()
		expect((await app.request(PATH, { method: 'GET' })).status).toBe(405)
		expect((await app.request(PATH, { method: 'DELETE' })).status).toBe(405)
	})
})
