import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, mockHandleRequest, MockTransport, mockCreateSlackMcpServer, mockDecrypt } =
	vi.hoisted(() => {
		const mockConnect = vi.fn().mockResolvedValue(undefined)
		const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
		const MockTransport = vi.fn().mockImplementation(() => ({
			handleRequest: mockHandleRequest,
		}))
		const mockCreateSlackMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
		const mockDecrypt = vi.fn()
		return { mockConnect, mockHandleRequest, MockTransport, mockCreateSlackMcpServer, mockDecrypt }
	})

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

vi.mock('../../lib/integrations/providers/slack/mcp-server', () => ({
	createSlackMcpServer: mockCreateSlackMcpServer,
	isSlackBotToken: (token: unknown) => typeof token === 'string' && token.startsWith('xoxb-'),
}))

vi.mock('../../lib/crypto', () => ({
	decrypt: mockDecrypt,
}))

import { createTestApp } from '../setup'
import { buildActor, buildIntegration, buildWorkspace, buildWorkspaceMember } from '../factories'

function createApp(actorId = 'test-actor-id') {
	return import('../../routes/integrations-slack-mcp').then((mod) => {
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

describe('POST /api/integrations/slack/mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns 400 when X-Workspace-Id header is missing', async () => {
		const { app } = await createApp()
		const res = await app.request(postRequest(JSONRPC_BODY))
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
	})

	it('returns 403 when the calling actor is not a member of the workspace', async () => {
		const actorId = 'actor-not-member'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()

		// actor row → found; workspace row → found; membership row → empty (not a member)
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
		expect(mockCreateSlackMcpServer).not.toHaveBeenCalled()
	})

	it('returns 400 when there is no active Slack integration for the workspace', async () => {
		const actorId = 'actor-no-slack'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })

		// actor → workspace → membership → no integration
		mockResults.selectQueue = [[actor], [workspace], [member], []]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }),
			undefined,
			env,
		)
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
		expect(mockCreateSlackMcpServer).not.toHaveBeenCalled()
	})

	it('returns 400 when the stored Slack token is not a bot token', async () => {
		const actorId = 'actor-xoxp'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({ provider: 'slack', status: 'active', workspaceId: workspace.id })

		mockDecrypt.mockReturnValue(JSON.stringify({ accessToken: 'xoxp-user-token' }))
		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }),
			undefined,
			env,
		)
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
		expect(mockCreateSlackMcpServer).not.toHaveBeenCalled()
	})

	it('creates the MCP server with per-agent identity and delegates to the transport', async () => {
		const actorId = 'actor-ok'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId, name: 'Synthesizer' })
		const workspace = buildWorkspace({ name: 'mesh-firm' })
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({ provider: 'slack', status: 'active', workspaceId: workspace.id })

		mockDecrypt.mockReturnValue(JSON.stringify({ accessToken: 'xoxb-real-bot-token' }))
		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }),
			undefined,
			env,
		)

		expect(mockCreateSlackMcpServer).toHaveBeenCalledWith(
			expect.objectContaining({
				botToken: 'xoxb-real-bot-token',
				agentLabel: 'Synthesizer · in mesh-firm',
				workspaceId: workspace.id,
				actorId,
			}),
		)
		expect(mockConnect).toHaveBeenCalledTimes(1)
		expect(mockHandleRequest).toHaveBeenCalledOnce()
		expect(res.headers.get('x-hono-already-sent')).toBe('1')
	})

	it('returns 400 for invalid JSON body', async () => {
		const actorId = 'actor-badjson'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({ provider: 'slack', status: 'active', workspaceId: workspace.id })

		mockDecrypt.mockReturnValue(JSON.stringify({ accessToken: 'xoxb-bot-token' }))
		// actor → workspace → membership → integration (all pass, then body parse fails)
		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]

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

describe('GET /api/integrations/slack/mcp', () => {
	it('returns 405 Method Not Allowed', async () => {
		const { app } = await createApp()
		const res = await app.request(new Request('http://localhost/', { method: 'GET' }))
		expect(res.status).toBe(405)
	})
})
