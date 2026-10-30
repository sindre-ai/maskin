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
			// no-op: this file asserts the route mounts and gates on workspace
			// write access; the JSON-RPC surface is covered by the server contract test.
		}
	},
}))

vi.mock('../../lib/integrations/providers/google-drive/mcp-server', () => ({
	createGoogleDriveMcpServer: vi.fn(() => ({ connect: vi.fn(async () => undefined) })),
}))

const gate = vi.fn()
vi.mock('../../lib/integrations/tool-gate', () => ({
	toolGateFor: vi.fn(async () => gate),
}))

vi.mock('../../lib/integrations/lookup', () => ({
	findIntegrationRow: vi.fn(async () => ({ id: 'drive-int-1' })),
}))

import { findIntegrationRow } from '../../lib/integrations/lookup'
import { createGoogleDriveMcpServer } from '../../lib/integrations/providers/google-drive/mcp-server'
import { toolGateFor } from '../../lib/integrations/tool-gate'
import { isWorkspaceWriter } from '../../lib/workspace-auth'
import googleDriveMcpRoutes from '../../routes/integrations-google-drive-mcp'

const PATH = '/api/integrations/google-drive/mcp'
const storage = { put: vi.fn() }
const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })

function mountedApp() {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db', {} as never)
		c.set('actorId', '11111111-1111-1111-1111-111111111111')
		c.set('storageProvider', storage as never)
		await next()
	})
	app.route(PATH, googleDriveMcpRoutes)
	return app
}

beforeEach(() => {
	vi.clearAllMocks()
	;(isWorkspaceWriter as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true)
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

	it('403s when the actor is not a writer in the workspace, and builds no server', async () => {
		;(isWorkspaceWriter as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
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
		expect(createGoogleDriveMcpServer).toHaveBeenCalledWith(
			{
				db: {},
				workspaceId: '22222222-2222-2222-2222-222222222222',
				actorId: '11111111-1111-1111-1111-111111111111',
				sessionId: 'sess-1',
				client: 'other',
				actorType: null,
				storage,
			},
			gate,
		)
	})

	it('gates the server on the caller access to the workspace Drive row', async () => {
		await mountedApp().request(
			PATH,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Workspace-Id': '22222222-2222-2222-2222-222222222222',
				},
				body: rpc,
			},
			{ outgoing: {}, incoming: {} },
		)
		expect(findIntegrationRow).toHaveBeenCalledWith(
			{},
			'22222222-2222-2222-2222-222222222222',
			'google-drive',
			null,
			expect.objectContaining({
				ctx: expect.objectContaining({
					requestingActorId: '11111111-1111-1111-1111-111111111111',
				}),
			}),
		)
		expect(toolGateFor).toHaveBeenCalledWith(
			{},
			{
				workspaceId: '22222222-2222-2222-2222-222222222222',
				actorId: '11111111-1111-1111-1111-111111111111',
				integrationId: 'drive-int-1',
				provider: 'google-drive',
				providerLabel: 'Google Drive',
			},
		)
	})

	it('passes no integration id to the gate when the workspace has no Drive connected', async () => {
		;(findIntegrationRow as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
		await mountedApp().request(
			PATH,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Workspace-Id': '22222222-2222-2222-2222-222222222222',
				},
				body: rpc,
			},
			{ outgoing: {}, incoming: {} },
		)
		expect(toolGateFor).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ integrationId: null, provider: 'google-drive' }),
		)
	})

	it('rejects GET and DELETE with 405', async () => {
		const app = mountedApp()
		expect((await app.request(PATH, { method: 'GET' })).status).toBe(405)
		expect((await app.request(PATH, { method: 'DELETE' })).status).toBe(405)
	})
})
