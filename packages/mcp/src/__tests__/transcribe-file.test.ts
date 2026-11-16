import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Drives the real transcribe_file handler registered by createMcpServer, with
// fetch stubbed to answer like POST /api/transcriptions/files/:id.
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

const wsId = '00000000-0000-0000-0000-0000000000aa'
const fileId = '11111111-1111-1111-1111-111111111111'

type ToolResult = { content: Array<{ type: string; text?: string }> }

describe('transcribe_file', () => {
	let handler: (args: Record<string, unknown>) => Promise<ToolResult>
	let definition: { inputSchema: Record<string, unknown> }

	function stubApi(status: number, body: unknown) {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () =>
				new Response(JSON.stringify(body), {
					status,
					headers: { 'Content-Type': 'application/json' },
				}),
		)
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, def, h) => {
			if (name === 'transcribe_file') {
				handler = h as typeof handler
				definition = def as typeof definition
			}
		})
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('posts to the file transcription route in the caller workspace and returns the transcript', async () => {
		const transcript = {
			file_id: fileId,
			name: 'standup.mp4',
			text: 'Good morning everyone.',
			audio_seconds: 12.5,
			chunks: 1,
			model: 'mistralai/voxtral-small-transcribe-3-0',
		}
		const fetchSpy = stubApi(200, transcript)

		const result = await handler({ workspace_id: wsId, id: fileId, language: 'en' })

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(`http://localhost:3000/api/transcriptions/files/${fileId}`)
		expect(init.method).toBe('POST')
		expect((init.headers as Record<string, string>)['X-Workspace-Id']).toBe(wsId)
		expect(JSON.parse(init.body as string)).toEqual({ language: 'en' })
		expect(JSON.parse(result.content[0].text as string)).toEqual(transcript)
	})

	it('sends an empty body when no language is given, so the language is detected', async () => {
		const fetchSpy = stubApi(200, { text: '' })

		await handler({ workspace_id: wsId, id: fileId })

		const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
		expect(JSON.parse(init.body as string)).toEqual({})
	})

	it('surfaces a plan-cap refusal as an error the agent can read', async () => {
		stubApi(402, {
			error: { code: 'PLAN_CAP_EXCEEDED', message: 'pro plan cap exceeded: $10.00 of $10.00 used' },
		})

		await expect(handler({ workspace_id: wsId, id: fileId })).rejects.toThrow(/API error 402/)
	})

	it('accepts only a uuid id and a language code', () => {
		const schema = z.object(definition.inputSchema as never)

		expect(schema.safeParse({ id: fileId }).success).toBe(true)
		expect(schema.safeParse({ id: fileId, language: 'nb-NO' }).success).toBe(true)
		expect(schema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
		expect(schema.safeParse({ id: fileId, language: 'English' }).success).toBe(false)
	})
})
