import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real create_file, update_file, list_files and list_file_tags handlers registered by
// createMcpServer, with fetch stubbed, and checks what reaches the file routes.
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

type Handler = (args: Record<string, unknown>) => Promise<{
	content: { text?: string }[]
	structuredContent?: unknown
}>

describe('file tags in the MCP file tools', () => {
	const handlers = new Map<string, Handler>()
	let tools: typeof import('../tools').tools
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		handlers.clear()
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers.set(name as string, h as Handler)
		})
		tools = (await import('../tools')).tools
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			// No-op sink so telemetry does not show up among the calls under test.
			telemetrySink: () => {},
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
		fetchMock.mockImplementation(async () => new Response(JSON.stringify([])))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const lastCall = () => {
		const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
		return { url: new URL(url), init, body: init.body ? JSON.parse(init.body as string) : null }
	}

	it('sends tags on create_file and leaves them out when not given', async () => {
		const create = handlers.get('create_file') as Handler
		const file = { workspace_id: wsId, name: 'a.mov', mime_type: 'video/quicktime', content: 'x' }

		await create({ ...file, tags: ['raw', 'clip_type:b_roll'] })
		expect(lastCall().body.tags).toEqual(['raw', 'clip_type:b_roll'])

		await create(file)
		expect(lastCall().body).not.toHaveProperty('tags')
	})

	it('sends the chat and work item on create_file and leaves them out when not given', async () => {
		const create = handlers.get('create_file') as Handler
		const file = { workspace_id: wsId, name: 'a.mov', mime_type: 'video/quicktime', content: 'x' }
		const chatId = '22222222-2222-2222-2222-222222222222'

		await create({ ...file, conversation_id: chatId, object_id: fileId })
		expect(lastCall().body).toMatchObject({ conversation_id: chatId, object_id: fileId })

		await create(file)
		expect(lastCall().body).not.toHaveProperty('conversation_id')
		expect(lastCall().body).not.toHaveProperty('object_id')
	})

	it('sends tags on update_file, including [] to clear them', async () => {
		const update = handlers.get('update_file') as Handler

		await update({ workspace_id: wsId, id: fileId, tags: ['final'] })
		expect(lastCall().body).toEqual({ tags: ['final'] })

		await update({ workspace_id: wsId, id: fileId, tags: [] })
		expect(lastCall().body).toEqual({ tags: [] })

		await update({ workspace_id: wsId, id: fileId, description: 'notes' })
		expect(lastCall().body).toEqual({ description: 'notes' })
	})

	it('filters list_files by tags and match setting, and returns each file with its tags', async () => {
		fetchMock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify([{ id: fileId, name: 'a.mov', tags: ['raw', 'b-roll'], createdAt: 'x' }]),
				),
		)
		const list = handlers.get('list_files') as Handler

		const result = await list({ workspace_id: wsId, tags: ['raw', 'b-roll'], tags_match: 'any' })

		const { url } = lastCall()
		expect(url.pathname).toBe('/api/files')
		expect(url.searchParams.get('tags')).toBe('raw,b-roll')
		expect(url.searchParams.get('tags_match')).toBe('any')
		expect(JSON.parse(result.content[0]?.text ?? '[]')[0].tags).toEqual(['raw', 'b-roll'])
	})

	it('sends no tag filter when none is asked for', async () => {
		await (handlers.get('list_files') as Handler)({ workspace_id: wsId, tags: [] })
		const { url } = lastCall()
		expect(url.searchParams.has('tags')).toBe(false)
		expect(url.searchParams.has('tags_match')).toBe(false)
	})

	it('lists the tags in use with their counts', async () => {
		const counts = [
			{ tag: 'b-roll', count: 3 },
			{ tag: 'raw', count: 1 },
		]
		fetchMock.mockImplementation(async () => new Response(JSON.stringify(counts)))

		const result = await (handlers.get('list_file_tags') as Handler)({ workspace_id: wsId })

		expect(lastCall().url.pathname).toBe('/api/files/tags')
		expect(JSON.parse(result.content[0]?.text ?? '[]')).toEqual(counts)
		expect(result.structuredContent).toEqual({ tags: counts })
	})

	it('renames a tag through the rename route', async () => {
		const result = { from: 'broll', to: 'b-roll', files_changed: 4 }
		fetchMock.mockImplementation(async () => new Response(JSON.stringify(result)))

		const out = await (handlers.get('rename_file_tag') as Handler)({
			workspace_id: wsId,
			from: 'broll',
			to: 'b-roll',
		})

		const { url, init, body } = lastCall()
		expect(url.pathname).toBe('/api/files/tags/rename')
		expect(init.method).toBe('POST')
		expect(body).toEqual({ from: 'broll', to: 'b-roll' })
		expect(JSON.parse(out.content[0]?.text ?? '{}')).toEqual(result)
	})

	it('merges a tag into another through the merge route', async () => {
		await (handlers.get('merge_file_tags') as Handler)({
			workspace_id: wsId,
			from: 'broll',
			into: 'b-roll',
		})

		const { url, init, body } = lastCall()
		expect(url.pathname).toBe('/api/files/tags/merge')
		expect(init.method).toBe('POST')
		expect(body).toEqual({ from: 'broll', into: 'b-roll' })
	})

	it('accepts a tag list and a match setting on the list_files input', () => {
		const input = tools.list_files.inputSchema
		expect(input.safeParse({ tags: ['raw'], tags_match: 'any' }).success).toBe(true)
		expect(input.safeParse({ tags_match: 'some' }).success).toBe(false)
	})
})
