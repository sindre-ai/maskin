import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real get_file / update_file handlers registered by createMcpServer,
// with fetch stubbed so the request each one sends can be read back.
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

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>

describe('get_file format and update_file edits', () => {
	const handlers: Record<string, Handler> = {}
	let tools: typeof import('../tools').tools
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers[name] = h as Handler
		})
		tools = (await import('../tools')).tools
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
		})
		fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => new Response(JSON.stringify({ id: fileId })))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function sentUrl(): string {
		return String(fetchMock.mock.calls[0][0])
	}

	function sentBody(): Record<string, unknown> {
		return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
	}

	it('get_file asks for the raw bytes by default', async () => {
		await handlers.get_file({ workspace_id: wsId, id: fileId })
		expect(sentUrl()).toBe(`http://localhost:3000/api/files/${fileId}`)
	})

	it('get_file sends format=text when asked', async () => {
		await handlers.get_file({ workspace_id: wsId, id: fileId, format: 'text' })
		expect(sentUrl()).toBe(`http://localhost:3000/api/files/${fileId}?format=text`)
	})

	it('get_file does not add a query for format raw', async () => {
		await handlers.get_file({ workspace_id: wsId, id: fileId, format: 'raw' })
		expect(sentUrl()).toBe(`http://localhost:3000/api/files/${fileId}`)
	})

	it('get_file passes the text response through as one JSON block', async () => {
		const body = { id: fileId, content_text: '## Hi', extracted: true }
		fetchMock.mockImplementation(async () => new Response(JSON.stringify(body)))
		const result = await handlers.get_file({ workspace_id: wsId, id: fileId, format: 'text' })
		expect(JSON.parse(result.content[0].text as string)).toEqual(body)
	})

	it('get_file schema accepts raw and text and rejects anything else', () => {
		const schema = tools.get_file.inputSchema
		expect(schema.safeParse({ id: fileId, format: 'text' }).success).toBe(true)
		expect(schema.safeParse({ id: fileId, format: 'pdf' }).success).toBe(false)
	})

	it('get_file describes the text format and says there is no offset or limit', () => {
		const description = tools.get_file.description
		expect(description).toContain('format: "text"')
		expect(description).toContain('content_text')
		expect(description).toContain('no offset or limit')
	})

	it('update_file forwards edits to the file route', async () => {
		const edits = [{ old: 'a', new: 'b', replace_all: true }]
		await handlers.update_file({ workspace_id: wsId, id: fileId, edits })
		expect(sentBody()).toEqual({ edits })
	})

	it('update_file forwards edits together with if_match', async () => {
		const edits = [{ old: 'a', new: 'b' }]
		const hash = 'a'.repeat(64)
		await handlers.update_file({ workspace_id: wsId, id: fileId, edits, if_match: hash })
		expect(sentBody()).toEqual({ edits, if_match: hash })
	})

	it('update_file schema bounds the edits list and requires old', () => {
		const schema = tools.update_file.inputSchema
		expect(schema.safeParse({ id: fileId, edits: [{ old: 'a', new: '' }] }).success).toBe(true)
		expect(schema.safeParse({ id: fileId, edits: [] }).success).toBe(false)
		expect(schema.safeParse({ id: fileId, edits: [{ old: '', new: 'b' }] }).success).toBe(false)
		const tooMany = Array.from({ length: 51 }, () => ({ old: 'a', new: 'b' }))
		expect(schema.safeParse({ id: fileId, edits: tooMany }).success).toBe(false)
	})

	it('update_file description explains edits, uniqueness and that they exclude content', () => {
		const description = tools.update_file.description
		expect(description).toContain('edits')
		expect(description).toContain('exactly once')
		expect(description).toContain('cannot be combined')
	})
})
