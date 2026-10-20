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

describe('request_keychain_credential', () => {
	let handler: (args: Record<string, unknown>) => Promise<ToolResult & { isError?: boolean }>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'request_keychain_credential') handler = h as typeof handler
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

	it('posts a Keychain card for the session and tells the agent to end its turn', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ posted: true, message_id: 9 }))

		const result = await handler({
			kind: 'login',
			suggested_name: 'e-conomic',
			hint: 'To read invoices.',
		})

		expect(paths()).toEqual([`/api/sessions/${SESSION_ID}/keychain-card`])
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body))).toEqual({
			kind: 'login',
			suggested_name: 'e-conomic',
			hint: 'To read invoices.',
		})
		const text = result.content[0]?.text ?? ''
		expect(text).toContain('Keychain card')
		expect(text).toContain('End your turn')
	})

	it('omits the optional fields it was not given', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ posted: true, message_id: 9 }))

		await handler({ kind: 'api_key' })

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body))).toEqual({ kind: 'api_key' })
	})

	it('reports an error the agent can act on when there is no person in a chat (409)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(409, 'Session is not an interactive chat session'))

		const result = await handler({ kind: 'api_key' })

		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('Do not ask for the secret in plain text')
	})

	it('reports the same error, without a request, outside an agent session', async () => {
		vi.stubEnv('SESSION_ID', '')
		createMcpServer(config)

		const result = await handler({ kind: 'api_key' })

		expect(result.isError).toBe(true)
		expect(paths()).toEqual([])
	})

	it('surfaces a non-409 failure rather than hiding it', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(500, 'Keychain card could not be posted'))

		await expect(handler({ kind: 'api_key' })).rejects.toThrow(/API error 500/)
	})
})
