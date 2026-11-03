import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as get-objects-include.test.ts: intercept registerAppTool so the
// connect_integration handler can be driven directly.
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
import { tools } from '../tools'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type ToolResult = { content: Array<{ text: string }> }

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function errorResponse(status: number, message: string): Response {
	return {
		ok: false,
		status,
		text: () => Promise.resolve(JSON.stringify({ error: { code: 'CONFLICT', message } })),
	} as Response
}

describe('connect_integration', () => {
	let handler: (args: Record<string, unknown>) => Promise<ToolResult>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'connect_integration') handler = h as typeof handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	function paths() {
		return fetchMock.mock.calls.map(([url]) => String(url).replace(config.apiBaseUrl, ''))
	}

	it('posts a Connect card instead of returning a URL when running in a chat session', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ posted: true, message_id: 5 }))

		const result = await handler({ provider: 'linear' })

		expect(paths()).toEqual([`/api/sessions/${SESSION_ID}/connect-card`])
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body))).toEqual({ provider: 'linear' })
		const text = result.content[0]?.text ?? ''
		expect(text).toContain('Connect card')
		expect(text).not.toContain('install_url')
	})

	it('never forwards an api_key to the card route', async () => {
		// The key belongs in the card's input, not in a model-authored tool call.
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ posted: true, message_id: 5 }))

		await handler({ provider: 'posthog', api_key: 'phx_secret' })

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(String(init.body)).not.toContain('phx_secret')
	})

	it('tells the agent to carry on when the provider is already connected', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ posted: false, already_connected: true }))

		const result = await handler({ provider: 'linear' })

		expect(result.content[0]?.text).toContain('already connected')
	})

	it('falls back to the URL flow when the session has no chat to show a card in (409)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock
			.mockResolvedValueOnce(errorResponse(409, 'Session is not an interactive chat session'))
			.mockResolvedValueOnce(jsonResponse({ install_url: 'https://linear.app/oauth/authorize' }))

		const result = await handler({ provider: 'linear' })

		expect(paths()).toEqual([
			`/api/sessions/${SESSION_ID}/connect-card`,
			'/api/integrations/linear/connect',
		])
		expect(result.content[0]?.text).toContain('https://linear.app/oauth/authorize')
	})

	it('goes straight to the URL flow outside an agent session', async () => {
		vi.stubEnv('SESSION_ID', '')
		createMcpServer(config)
		fetchMock.mockResolvedValue(jsonResponse({ install_url: 'https://linear.app/oauth/authorize' }))

		await handler({ provider: 'linear' })

		expect(paths()).toEqual(['/api/integrations/linear/connect'])
	})

	it('surfaces a non-409 failure rather than silently falling back', async () => {
		// A 400 here means the provider name is wrong. Falling back would hit the
		// same bad name and hide which call failed first.
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(400, 'Unknown integration provider: nope'))

		await expect(handler({ provider: 'nope' })).rejects.toThrow(/API error 400/)
		expect(paths()).toEqual([`/api/sessions/${SESSION_ID}/connect-card`])
	})
})

describe('reconnecting a non-active integration', () => {
	let listHandler: (args: Record<string, unknown>) => Promise<ToolResult>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'list_integrations') listHandler = h as typeof listHandler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const row = (id: string, provider: string, status: string) => ({
		id,
		provider,
		status,
		createdAt: '2026-10-19T07:00:00.000Z',
	})

	it('connect_integration description says it re-authenticates a non-active connection', () => {
		expect(tools.connect_integration.description).toContain('re-authenticate')
		expect(tools.connect_integration.description).toContain('not active')
	})

	it('list_integrations text points a revoked row at connect_integration', async () => {
		createMcpServer(config)
		fetchMock.mockResolvedValue(
			jsonResponse([row('a', 'gmail', 'revoked'), row('b', 'slack', 'active')]),
		)

		const text = (await listHandler({})).content[0]?.text ?? ''

		expect(text).toContain('Needs reconnecting: gmail (revoked)')
		expect(text).toContain('connect_integration')
		expect(text).not.toContain('slack (')
	})

	it('list_integrations text carries no hint when every row is active', async () => {
		createMcpServer(config)
		fetchMock.mockResolvedValue(
			jsonResponse([row('a', 'gmail', 'active'), row('b', 'slack', 'active')]),
		)

		const text = (await listHandler({})).content[0]?.text ?? ''

		expect(text).not.toContain('Needs reconnecting')
		expect(() => JSON.parse(text)).not.toThrow()
	})

	it('list_integrations text ignores a pending row, which is an unfinished connect', async () => {
		createMcpServer(config)
		fetchMock.mockResolvedValue(jsonResponse([row('a', 'gmail', 'pending')]))

		const text = (await listHandler({})).content[0]?.text ?? ''

		expect(text).not.toContain('Needs reconnecting')
	})
})
