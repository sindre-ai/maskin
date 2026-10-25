import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function errorResponse(status: number, message: string): Response {
	return {
		ok: false,
		status,
		text: () => Promise.resolve(JSON.stringify({ error: { code: 'ERR', message } })),
	} as Response
}

describe('request_integration_access', () => {
	const handlers: Record<string, Handler> = {}
	let fetchMock: ReturnType<typeof vi.spyOn>
	const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers[name] = h as Handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	const paths = () =>
		fetchMock.mock.calls.map(([url]) => String(url).replace(config.apiBaseUrl, ''))

	it('posts the card for the integration and level, and tells the agent to end its turn', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(
			jsonResponse({ posted: true, already_granted: false, message_id: 4 }),
		)

		const result = await handlers.request_integration_access({
			integration_id: INTEGRATION_ID,
			level: 'read_write',
			reason: 'To post the summary.',
		})

		expect(paths()).toEqual([`/api/sessions/${SESSION_ID}/integration-access-card`])
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body))).toEqual({
			integration_id: INTEGRATION_ID,
			level: 'read_write',
			reason: 'To post the summary.',
		})
		expect(result.content[0]?.text).toContain('End your turn')
		expect(result.isError).toBeUndefined()
	})

	it('says so, with no card, when the agent already has that access', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(
			jsonResponse({ posted: false, already_granted: true, message_id: null }),
		)
		const result = await handlers.request_integration_access({
			integration_id: INTEGRATION_ID,
			level: 'read',
		})
		expect(result.content[0]?.text).toContain('already have that access')
		expect(result.content[0]?.text).not.toContain('End your turn')
	})

	it('points at the list tool when no connected integration has that id (404)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(404, 'No integration'))
		const result = await handlers.request_integration_access({
			integration_id: INTEGRATION_ID,
			level: 'read',
		})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('list_integrations')
	})

	it('points a saved key at the keychain tools (400)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(400, 'Saved key'))
		const result = await handlers.request_integration_access({
			integration_id: INTEGRATION_ID,
			level: 'read',
		})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('request_keychain_access')
	})

	it('reports there is nobody to ask when the session is not a chat (409)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(409, 'Not interactive'))
		const result = await handlers.request_integration_access({
			integration_id: INTEGRATION_ID,
			level: 'read',
		})
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('no person in a chat')
	})

	it('errors without a request outside an agent session', async () => {
		vi.stubEnv('SESSION_ID', '')
		createMcpServer(config)
		const result = await handlers.request_integration_access({
			integration_id: INTEGRATION_ID,
			level: 'read',
		})
		expect(result.isError).toBe(true)
		expect(paths()).toEqual([])
	})
})
