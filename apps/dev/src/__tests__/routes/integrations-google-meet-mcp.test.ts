import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, mockHandleRequest, MockTransport, mockCreateGoogleMeetMcpServer } = vi.hoisted(
	() => {
		const mockConnect = vi.fn().mockResolvedValue(undefined)
		const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
		const MockTransport = vi.fn().mockImplementation(() => ({
			handleRequest: mockHandleRequest,
		}))
		const mockCreateGoogleMeetMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
		return { mockConnect, mockHandleRequest, MockTransport, mockCreateGoogleMeetMcpServer }
	},
)

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

vi.mock('../../lib/integrations/providers/google-meet/mcp-server', () => ({
	createGoogleMeetMcpServer: mockCreateGoogleMeetMcpServer,
}))

import { buildWorkspaceMember } from '../factories'
import { createTestApp } from '../setup'

function createApp(actorId = 'test-actor-id') {
	return import('../../routes/integrations-google-meet-mcp').then((mod) => {
		const { app, mockResults } = createTestApp(mod.default, '/', actorId)
		return { app, mockResults }
	})
}

function postRequest(body: unknown, headers: Record<string, string> = {}) {
	return new Request('http://localhost/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

function createEnv() {
	const mockNodeRes = {
		writeHead: vi.fn(),
		write: vi.fn(),
		end: vi.fn(),
		headersSent: false,
		setHeader: vi.fn(),
	}
	const mockNodeReq = { url: '/', method: 'POST' }
	return { env: { incoming: mockNodeReq, outgoing: mockNodeRes } }
}

const JSONRPC_BODY = { jsonrpc: '2.0', method: 'tools/list', id: 1 }

describe('POST /api/integrations/google-meet/mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns 400 when X-Workspace-Id header is missing', async () => {
		const { app } = await createApp()
		const res = await app.request(postRequest(JSONRPC_BODY))
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
		expect(mockCreateGoogleMeetMcpServer).not.toHaveBeenCalled()
	})

	it('returns 403 when the calling actor is not a member of the workspace', async () => {
		const actorId = 'actor-not-member'
		const { app, mockResults } = await createApp(actorId)

		// isWorkspaceMember → empty
		mockResults.selectQueue = [[]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': 'ws-1' }),
			undefined,
			env,
		)
		expect(res.status).toBe(403)
		const json = await res.json()
		expect(json.error.code).toBe('FORBIDDEN')
		expect(mockCreateGoogleMeetMcpServer).not.toHaveBeenCalled()
	})

	it('builds the MCP server with { db, workspaceId, actorId } and hands off to the transport', async () => {
		const actorId = 'actor-ok'
		const workspaceId = 'ws-42'
		const { app, mockResults } = await createApp(actorId)

		const member = buildWorkspaceMember({ actorId, workspaceId })
		// isWorkspaceMember → one row
		mockResults.selectQueue = [[member]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspaceId }),
			undefined,
			env,
		)

		expect(res.headers.get('x-hono-already-sent')).toBe('1')
		expect(mockCreateGoogleMeetMcpServer).toHaveBeenCalledOnce()
		const arg = mockCreateGoogleMeetMcpServer.mock.calls[0][0]
		expect(arg.workspaceId).toBe(workspaceId)
		expect(arg.actorId).toBe(actorId)
		expect(arg.db).toBeDefined()
		expect(mockConnect).toHaveBeenCalledOnce()
		expect(mockHandleRequest).toHaveBeenCalledOnce()
	})

	it('returns 400 on invalid JSON body', async () => {
		const actorId = 'actor-ok'
		const { app, mockResults } = await createApp(actorId)
		mockResults.selectQueue = [[buildWorkspaceMember({ actorId, workspaceId: 'ws-1' })]]

		const req = new Request('http://localhost/', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': 'ws-1' },
			body: '{not-json',
		})
		const { env } = createEnv()
		const res = await app.request(req, undefined, env)
		expect(res.status).toBe(400)
		expect(mockCreateGoogleMeetMcpServer).toHaveBeenCalled()
	})

	it('returns 405 on GET', async () => {
		const { app } = await createApp()
		const res = await app.request(new Request('http://localhost/', { method: 'GET' }))
		expect(res.status).toBe(405)
	})
})
