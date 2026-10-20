import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as get-objects-include.test.ts: intercept registerAppTool so the
// post_draft handler can be driven directly.
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

describe('post_draft', () => {
	let handler: (args: Record<string, unknown>) => Promise<ToolResult & { isError?: boolean }>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'post_draft') handler = h as typeof handler
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	const EMAIL = {
		kind: 'email',
		to: 'Mette Holm, Northwind',
		subject: 'Following up',
		body: 'Hi Mette,',
	}

	it('posts the draft to the session and tells the agent to end its turn', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ message_id: 5, object_id: 'task-1' }))

		const result = await handler(EMAIL)

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(String(url)).toBe(`http://localhost:3000/api/sessions/${SESSION_ID}/draft`)
		expect(JSON.parse(String(init.body))).toMatchObject(EMAIL)
		const text = result.content[0]?.text ?? ''
		expect(text).toContain('task-1')
		expect(text).toContain('Nothing has been sent')
		expect(result.isError).toBeUndefined()
	})

	it('points an email draft at gmail_send_email, and no other kind', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(jsonResponse({ message_id: 5, object_id: 'task-1' }))

		const email = await handler(EMAIL)
		const post = await handler({ kind: 'linkedin_post', body: 'A post' })

		expect(email.content[0]?.text).toContain('gmail_send_email with draft_object_id task-1')
		expect(post.content[0]?.text).not.toContain('gmail_send_email')
	})

	it('says there is no chat, as an error, when not running in a session', async () => {
		vi.stubEnv('SESSION_ID', '')
		createMcpServer(config)

		const result = await handler(EMAIL)

		expect(fetchMock).not.toHaveBeenCalled()
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('no chat')
	})

	it('tells the agent to make the task itself when the session has no chat (409)', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(409, 'Session is not an interactive chat session'))

		const result = await handler(EMAIL)

		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain('no chat')
	})

	it('lets a validation failure through so the agent can fix the draft', async () => {
		createMcpServer({ ...config, maskinSessionId: SESSION_ID })
		fetchMock.mockResolvedValue(errorResponse(400, 'An email needs a subject'))

		await expect(handler({ ...EMAIL, subject: undefined })).rejects.toThrow()
	})
})
