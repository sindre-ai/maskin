import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
	mockConnect,
	mockHandleRequest,
	MockTransport,
	mockCreateGoogleCalendarMcpServer,
	mockGetValidToken,
} = vi.hoisted(() => {
	const mockConnect = vi.fn().mockResolvedValue(undefined)
	const mockHandleRequest = vi.fn().mockResolvedValue(undefined)
	const MockTransport = vi.fn().mockImplementation(() => ({
		handleRequest: mockHandleRequest,
	}))
	const mockCreateGoogleCalendarMcpServer = vi.fn().mockReturnValue({ connect: mockConnect })
	const mockGetValidToken = vi.fn()
	return {
		mockConnect,
		mockHandleRequest,
		MockTransport,
		mockCreateGoogleCalendarMcpServer,
		mockGetValidToken,
	}
})

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: MockTransport,
}))

vi.mock('../../lib/integrations/mcp/google-calendar/mcp-server', () => ({
	createGoogleCalendarMcpServer: mockCreateGoogleCalendarMcpServer,
}))

vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: vi.fn().mockImplementation(() => ({
		getValidToken: mockGetValidToken,
	})),
}))

import { buildActor, buildIntegration, buildWorkspace, buildWorkspaceMember } from '../factories'
import { createTestApp } from '../setup'

function createApp(actorId = 'test-actor-id') {
	return import('../../routes/integrations-google-calendar-mcp').then((mod) => {
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

describe('POST /api/integrations/google-calendar/mcp', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGetValidToken.mockReset()
		mockGetValidToken.mockResolvedValue('ya29.refreshed-access-token')
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

		// actor → workspace → membership (empty)
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
		expect(mockCreateGoogleCalendarMcpServer).not.toHaveBeenCalled()
	})

	it('returns 400 when there is no active google-calendar integration for the workspace', async () => {
		const actorId = 'actor-no-gcal'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })

		// actor → workspace → membership → no integration row
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
		expect(mockCreateGoogleCalendarMcpServer).not.toHaveBeenCalled()
	})

	it('returns 401 auth_revoked when token resolution fails (AC-T3 surface)', async () => {
		const actorId = 'actor-revoked'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({
			provider: 'google-calendar',
			status: 'active',
			workspaceId: workspace.id,
			externalId: 'magnus@example.com',
		})

		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]
		mockGetValidToken.mockRejectedValueOnce(new Error('invalid_grant'))

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }),
			undefined,
			env,
		)
		expect(res.status).toBe(401)
		const json = await res.json()
		expect(json.error.code).toBe('auth_revoked')
		expect(mockCreateGoogleCalendarMcpServer).not.toHaveBeenCalled()
	})

	it('constructs the MCP server with refreshed token + connected email + idempotency key', async () => {
		const actorId = 'actor-ok'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId, name: 'Synthesizer' })
		const workspace = buildWorkspace({ name: 'mesh-firm' })
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({
			provider: 'google-calendar',
			status: 'active',
			workspaceId: workspace.id,
			externalId: 'magnus@example.com',
		})

		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]

		const { env } = createEnv()
		const res = await app.request(
			postRequest(JSONRPC_BODY, {
				'X-Workspace-Id': workspace.id,
				'Idempotency-Key': 'idem-2026-07-04-strategy',
			}),
			undefined,
			env,
		)

		expect(mockCreateGoogleCalendarMcpServer).toHaveBeenCalledWith(
			expect.objectContaining({
				accessToken: 'ya29.refreshed-access-token',
				workspaceId: workspace.id,
				actorId,
				connectedEmail: 'magnus@example.com',
				idempotencyKey: 'idem-2026-07-04-strategy',
			}),
		)
		expect(mockConnect).toHaveBeenCalledTimes(1)
		expect(mockHandleRequest).toHaveBeenCalledOnce()
		expect(res.headers.get('x-hono-already-sent')).toBe('1')
	})

	it('passes through without an idempotency key when the header is absent', async () => {
		const actorId = 'actor-no-idem'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({
			provider: 'google-calendar',
			status: 'active',
			workspaceId: workspace.id,
			externalId: 'magnus@example.com',
		})

		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]

		const { env } = createEnv()
		await app.request(postRequest(JSONRPC_BODY, { 'X-Workspace-Id': workspace.id }), undefined, env)

		expect(mockCreateGoogleCalendarMcpServer).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: undefined }),
		)
	})

	it('returns 400 for invalid JSON body', async () => {
		const actorId = 'actor-badjson'
		const { app, mockResults } = await createApp(actorId)

		const actor = buildActor({ id: actorId })
		const workspace = buildWorkspace()
		const member = buildWorkspaceMember({ actorId, workspaceId: workspace.id })
		const integration = buildIntegration({
			provider: 'google-calendar',
			status: 'active',
			workspaceId: workspace.id,
		})

		mockResults.selectQueue = [[actor], [workspace], [member], [integration]]

		const { env } = createEnv()
		const res = await app.request(
			new Request('http://localhost/', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id },
				body: 'not json {{{',
			}),
			undefined,
			env,
		)
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('BAD_REQUEST')
	})
})

describe('GET /api/integrations/google-calendar/mcp', () => {
	it('returns 405 Method Not Allowed', async () => {
		const { app } = await createApp()
		const res = await app.request(new Request('http://localhost/', { method: 'GET' }))
		expect(res.status).toBe(405)
	})
})
