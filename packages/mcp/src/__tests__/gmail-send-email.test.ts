import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as post-draft.test.ts: intercept registerAppTool so the handler can be driven directly.
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

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type Result = { content: Array<{ text: string }>; isError?: boolean }

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

describe('gmail_send_email', () => {
	let handler: (args: Record<string, unknown>) => Promise<Result>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'gmail_send_email') handler = h as typeof handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('sends a new email through the Gmail route', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ message_id: 'm1', thread_id: null, mode: 'direct' }))

		const result = await handler({ to: 'ada@example.com', subject: 'Hi', body: 'Hello' })

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(String(url)).toBe('http://localhost:3000/api/integrations/gmail/send')
		expect(JSON.parse(String(init.body))).toMatchObject({
			to: 'ada@example.com',
			subject: 'Hi',
			body: 'Hello',
		})
		expect(result.isError).toBeUndefined()
		expect(result.content[0]?.text).toContain('Do not send it again')
	})

	it('sends an approved email by its approval card id alone', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ message_id: 'm1', thread_id: null, mode: 'approved_draft' }),
		)

		const result = await handler({ approval_comment_id: 4821 })

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(String(init.body))).toMatchObject({
			approval_comment_id: 4821,
		})
		expect(result.content[0]?.text).toContain('exactly as the person approved')
	})

	it("hands the server's refusal back as a result with what to do next", async () => {
		fetchMock.mockResolvedValue(
			errorResponse(
				403,
				'ada@example.com is marked as protected, so a person has to approve this email first.',
				'Post a decision comment with the draft.',
			),
		)

		const result = await handler({ to: 'ada@example.com', subject: 'Hi', body: 'Hello' })

		expect(result.isError).toBe(true)
		const text = result.content[0]?.text ?? ''
		expect(text).toContain('Not sent.')
		expect(text).toContain('marked as protected')
		expect(text).toContain('decision comment')
	})
})
