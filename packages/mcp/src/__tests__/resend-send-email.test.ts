import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as gmail-send-email.test.ts: intercept registerAppTool so the handler can be driven directly.
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

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type Result = { content: Array<{ text: string }>; isError?: boolean }

const OBJECT_ID = '3f6c1b5e-7a0e-4d6f-9f43-1c2b7d9a8e10'

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function errorResponse(status: number, message: string, suggestion?: string): Response {
	return {
		ok: false,
		status,
		text: () =>
			Promise.resolve(JSON.stringify({ error: { code: 'FORBIDDEN', message, suggestion } })),
	} as Response
}

describe('resend_send_email', () => {
	let handler: (args: Record<string, unknown>) => Promise<Result>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'resend_send_email') handler = h as typeof handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('takes only an object id: no recipient, subject, body or sender to pass', () => {
		expect(Object.keys(tools.resend_send_email.inputSchema.shape).sort()).toEqual([
			'object_id',
			'workspace_id',
		])
	})

	it('sends an approved email object by its id alone', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ email_id: 'em_1', from: 'dev@example.com', mode: 'approved_draft' }),
		)

		const result = await handler({ object_id: OBJECT_ID })

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(String(url)).toBe('http://localhost:3000/api/integrations/resend/send')
		expect(JSON.parse(String(init.body))).toEqual({ object_id: OBJECT_ID })
		expect(result.isError).toBeUndefined()
		expect(result.content[0]?.text).toContain('Sent from dev@example.com')
		expect(result.content[0]?.text).toContain('Do not send it again')
	})

	it('hands a refusal back as a result the agent can act on', async () => {
		fetchMock.mockResolvedValue(
			errorResponse(403, 'A person has to approve this email first.', 'End your turn.'),
		)

		const result = await handler({ object_id: OBJECT_ID })

		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('Not sent.')
		expect(result.content[0]?.text).toContain('A person has to approve this email first.')
	})
})
