import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real get_file handler registered by createMcpServer, with fetch
// stubbed to return a file row shaped like GET /api/files/:id.
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

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string }

describe('get_file response blocks', () => {
	let handler: (args: Record<string, unknown>) => Promise<{ content: ContentBlock[] }>

	async function callWith(row: Record<string, unknown>) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () =>
				new Response(JSON.stringify(row), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		)
		return handler({ workspace_id: wsId, id: fileId })
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'get_file') handler = h as typeof handler
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

	it('returns images as metadata text plus a real image block', async () => {
		const result = await callWith({
			id: fileId,
			name: 'IMG_7361.jpg',
			mimeType: 'image/jpeg',
			content: '/9j/4AAQSkZJRg==',
			encoding: 'base64',
			annotations: [],
			url: 'https://maskin.io/file',
		})

		expect(result.content).toHaveLength(2)
		const [meta, image] = result.content
		expect(meta.type).toBe('text')
		const parsed = JSON.parse(meta.text as string)
		expect(parsed.name).toBe('IMG_7361.jpg')
		expect(parsed.url).toBe('https://maskin.io/file')
		expect(parsed).not.toHaveProperty('content')
		expect(image).toEqual({ type: 'image', data: '/9j/4AAQSkZJRg==', mimeType: 'image/jpeg' })
	})

	it('keeps text files as a single JSON text block with content', async () => {
		const row = {
			id: fileId,
			name: 'notes.md',
			mimeType: 'text/markdown',
			content: '# hello',
			encoding: 'utf8',
			annotations: [],
			url: 'https://maskin.io/file',
		}
		const result = await callWith(row)

		expect(result.content).toHaveLength(1)
		expect(result.content[0].type).toBe('text')
		expect(JSON.parse(result.content[0].text as string)).toEqual(row)
	})

	it('keeps non-image binary files as a single JSON text block with content', async () => {
		const row = {
			id: fileId,
			name: 'doc.pdf',
			mimeType: 'application/pdf',
			content: 'JVBERi0=',
			encoding: 'base64',
			annotations: [],
			url: 'https://maskin.io/file',
		}
		const result = await callWith(row)

		expect(result.content).toHaveLength(1)
		expect(JSON.parse(result.content[0].text as string)).toEqual(row)
	})
})
