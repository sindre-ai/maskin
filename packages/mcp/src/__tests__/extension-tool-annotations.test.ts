import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mock scaffold as surface-pin.test.ts: build the server without side effects and read
// back what each tool was registered with.
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

describe('extensionToolTitle', () => {
	it('turns a tool name into a plain sentence-case title', async () => {
		const { extensionToolTitle } = await import('../annotations')
		expect(extensionToolTitle('create_contact')).toBe('Create contact')
		expect(extensionToolTitle('list-open-deals')).toBe('List open deals')
		expect(extensionToolTitle('search')).toBe('Search')
	})
})

describe('extension tool annotations', () => {
	let registered: Map<string, Record<string, unknown>>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		registered = new Map()
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, definition) => {
			registered.set(name as string, definition as Record<string, unknown>)
		})
		const { z } = await import('zod')
		const { registerModule } = await import('@maskin/module-sdk')
		registerModule({
			id: 'demoext',
			name: 'Demo',
			version: '0.0.1',
			objectTypes: [],
			mcpTools: [
				{
					name: 'list_widgets',
					description: 'Lists widgets.',
					inputSchema: z.object({}),
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				},
				{
					name: 'create_widget',
					description: 'Creates a widget.',
					inputSchema: z.object({}),
					handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
				},
			],
		})
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: '00000000-0000-0000-0000-0000000000aa',
			telemetrySink: () => {},
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('gives every extension tool a plain title and the changes-data label', () => {
		for (const [name, title] of [
			['demoext_list_widgets', 'List widgets'],
			['demoext_create_widget', 'Create widget'],
		]) {
			const def = registered.get(name)
			expect(def, `${name} was not registered`).toBeDefined()
			expect(def?.title).toBe(title)
			expect(def?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			})
		}
	})

	it('leaves the platform table without a row for them', async () => {
		const { TOOL_ANNOTATIONS } = await import('../annotations')
		expect(Object.keys(TOOL_ANNOTATIONS).filter((n) => n.startsWith('demoext_'))).toEqual([])
	})
})
