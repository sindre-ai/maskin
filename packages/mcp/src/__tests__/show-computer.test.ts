import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as request-keychain-credential.test.ts: intercept registerAppTool so
// the show_computer handler can be driven directly.
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

type ToolResult = { content: Array<{ text: string }>; isError?: boolean }

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

describe('show_computer', () => {
	let handler: (args: Record<string, unknown>) => Promise<ToolResult>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'show_computer') handler = h as typeof handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	const paths = () =>
		fetchMock.mock.calls.map(([url]) => String(url).replace(config.apiBaseUrl, ''))

	it('posts a computer card for the session and tells the agent to end its turn', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ posted: true, message_id: 9 }))

		const result = await handler({ task: 'Approve the 2FA prompt on e-conomic.' })

		expect(paths()).toEqual([`/api/sessions/${SESSION_ID}/computer-card`])
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body))).toEqual({ task: 'Approve the 2FA prompt on e-conomic.' })
		const text = result.content[0]?.text ?? ''
		expect(text).toContain('End your turn')
		expect(text).toContain('desktop_screenshot')
		expect(result.isError).toBeUndefined()
	})

	it('never names another agent: the tool takes no agent_id at all', () => {
		expect(Object.keys(tools.show_computer.inputSchema.shape).sort()).toEqual(
			['task', 'workspace_id'].sort(),
		)
	})

	it('reports an error the agent can act on when there is no person in a chat (409)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(409, 'Session is not an interactive chat session'))

		const result = await handler({ task: 'Log in.' })

		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('no person in a chat')
	})

	it('says computers are unavailable when the workspace does not have them (404)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(404, 'Computers are not available'))

		const result = await handler({ task: 'Log in.' })

		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('not available in this workspace')
	})

	it('reports the same error, without a request, outside an agent session', async () => {
		vi.stubEnv('SESSION_ID', '')
		createMcpServer(config)

		const result = await handler({ task: 'Log in.' })

		expect(result.isError).toBe(true)
		expect(paths()).toEqual([])
	})

	it('rejects an empty or over-long task at the schema', () => {
		const task = tools.show_computer.inputSchema.shape.task
		expect(task.safeParse('').success).toBe(false)
		expect(task.safeParse('x'.repeat(501)).success).toBe(false)
		expect(task.safeParse('Log in.').success).toBe(true)
	})
})
