import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, mockHandleRequest, MockTransport, mockCreateEmailMcpServer } = vi.hoisted(
	() => {
		const mockConnect = vi.fn().mockResolvedValue(undefined)
		const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
		const MockTransport = vi.fn().mockImplementation(() => ({
			handleRequest: mockHandleRequest,
		}))
		const mockCreateEmailMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
		return { mockConnect, mockHandleRequest, MockTransport, mockCreateEmailMcpServer }
	},
)

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

vi.mock('../../lib/integrations/providers/email/mcp-server', () => ({
	createEmailMcpServer: mockCreateEmailMcpServer,
}))

import { buildActor, buildWorkspace, buildWorkspaceMember } from '../factories'
import { createTestApp } from '../setup'

function createApp(actorId = 'test-actor-id') {
	return import('../../routes/integrations-email-mcp').then((mod) => {
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

describe('POST /api/integrations/email/mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns 400 when X-Workspace-Id header is missing', async () => {
		const { app } = await createApp()
		const res = await app.request(postRequest(JSONRPC_BODY))
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
		expect(mockCreateEmailMcpServer).not.toHaveBeenCalled()
	})

	it('returns 404 when the calling actor is not found', async () => {
		const actorId = 'actor-missing'
		const { app, mockResults } = await createApp(actorId)

		// actor row → empty
		mockResults.selectQueue = [[]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': 'ws-1' }),
			undefined,
			env,
		)
		expect(res.status).toBe(404)
		const json = await res.json()
		expect(json.error.code).toBe('NOT_FOUND')
		expect(mockCreateEmailMcpServer).not.toHaveBeenCalled()
	})

	it('returns 404 when the workspace does not exist', async () => {
		const actorId = 'actor-1'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		mockResults.selectQueue = [[actor], []]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': 'ws-missing' }),
			undefined,
			env,
		)
		expect(res.status).toBe(404)
		const json = await res.json()
		expect(json.error.code).toBe('NOT_FOUND')
		expect(mockCreateEmailMcpServer).not.toHaveBeenCalled()
	})

	it('returns 403 when the calling actor is not a member of the workspace', async () => {
		const actorId = 'actor-not-member'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()

		mockResults.selectQueue = [[actor], [workspace], []]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }),
			undefined,
			env,
		)
		expect(res.status).toBe(403)
		const json = await res.json()
		expect(json.error.code).toBe('FORBIDDEN')
		expect(mockCreateEmailMcpServer).not.toHaveBeenCalled()
	})

	it('creates the MCP server with per-agent identity and delegates to the transport on the happy path', async () => {
		const actorId = 'actor-ok'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId, name: 'Synthesizer' })
		const workspace = buildWorkspace({ name: 'mesh-firm' })
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })

		mockResults.selectQueue = [[actor], [workspace], [member]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }),
			undefined,
			env,
		)

		expect(mockCreateEmailMcpServer).toHaveBeenCalledWith({
			workspaceId: workspace.id,
			actorId,
			agentLabel: 'Synthesizer · in mesh-firm',
			db: expect.anything(),
		})
		expect(mockConnect).toHaveBeenCalledTimes(1)
		expect(mockHandleRequest).toHaveBeenCalledOnce()
		expect(res.headers.get('x-hono-already-sent')).toBe('1')
	})

	it('returns 400 for an invalid JSON body', async () => {
		const actorId = 'actor-badjson'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })

		mockResults.selectQueue = [[actor], [workspace], [member]]

		const { env } = createEnv()
		const res = await app.request(
			new Request('http://localhost/', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Workspace-Id': workspace.id,
				},
				body: 'not json {{{',
			}),
			undefined,
			env,
		)
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
		expect(json.error.message).toBe('Invalid JSON in request body')
	})
})

describe('GET/DELETE /api/integrations/email/mcp', () => {
	it('returns 405 for GET', async () => {
		const { app } = await createApp()
		const res = await app.request(new Request('http://localhost/', { method: 'GET' }))
		expect(res.status).toBe(405)
	})

	it('returns 405 for DELETE', async () => {
		const { app } = await createApp()
		const res = await app.request(new Request('http://localhost/', { method: 'DELETE' }))
		expect(res.status).toBe(405)
	})
})
