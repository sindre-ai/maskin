import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real update_file handler registered by createMcpServer, with fetch
// stubbed to answer like PATCH /api/files/:id (apps/dev/src/routes/files.ts).
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
const staleHash = 'a'.repeat(64)
const currentHash = 'b'.repeat(64)

describe('update_file if_match', () => {
	let handler: (args: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>
	let schema: { safeParse: (v: unknown) => { success: boolean } }
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			if (name === 'update_file') handler = h as typeof handler
		})
		const { tools } = await import('../tools')
		schema = tools.update_file.inputSchema
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function sentBody(): Record<string, unknown> {
		const init = fetchMock.mock.calls[0][1] as RequestInit
		return JSON.parse(init.body as string)
	}

	it('forwards if_match to the file route', async () => {
		fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: fileId })))

		await handler({ workspace_id: wsId, id: fileId, content: '# mine', if_match: currentHash })

		expect(sentBody()).toEqual({ content: '# mine', if_match: currentHash })
	})

	it('leaves if_match out when the caller did not pass one', async () => {
		fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: fileId })))

		await handler({ workspace_id: wsId, id: fileId, content: '# mine' })

		expect(sentBody()).toEqual({ content: '# mine' })
	})

	it('surfaces the 409 with the current hash when the file changed since read', async () => {
		fetchMock.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 'CONFLICT',
							message: 'File changed since it was loaded',
							details: [
								{
									field: 'if_match',
									message: 'if_match does not match the current content hash',
									expected: currentHash,
									received: staleHash,
								},
							],
							suggestion: 'Fetch the file again and decide whether to load the new version.',
						},
						currentHash,
					}),
					{ status: 409 },
				),
		)

		const call = handler({ id: fileId, content: '# mine', if_match: staleHash })

		await expect(call).rejects.toThrow(/API error 409: File changed since it was loaded/)
		await expect(call).rejects.toThrow(new RegExp(`expected: ${currentHash}`))
		await expect(call).rejects.toThrow(/Fetch the file again/)
	})

	it('rejects an if_match that is not a sha256 hex digest', () => {
		expect(schema.safeParse({ id: fileId, content: 'x', if_match: 'nope' }).success).toBe(false)
		expect(schema.safeParse({ id: fileId, if_match: staleHash }).success).toBe(true)
	})
})
