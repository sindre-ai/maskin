import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real set_loop_view and query_data handlers registered by
// createMcpServer, with fetch stubbed to answer like the API routes they call.
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
const loopId = '11111111-1111-1111-1111-111111111111'
const fileId = '22222222-2222-2222-2222-222222222222'

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>

describe('loop view MCP tools', () => {
	let handlers: Record<string, Handler>
	let tools: typeof import('../tools').tools
	let fetchMock: ReturnType<typeof vi.spyOn>
	let responses: Record<string, unknown>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		handlers = {}
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers[name as string] = h as Handler
		})
		tools = (await import('../tools')).tools
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			telemetrySink: () => {},
		})
		responses = {
			[`/api/objects/${loopId}`]: { id: loopId, type: 'loop', metadata: {} },
			[`/api/files?ids=${fileId}`]: [{ id: fileId, mimeType: 'text/html; charset=utf-8' }],
		}
		fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const path = String(input).replace('http://localhost:3000', '')
			const body = responses[path] ?? responses[path.split('?')[0]]
			if (body === undefined) return new Response('not found', { status: 404 })
			return new Response(JSON.stringify(body))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const calls = () =>
		fetchMock.mock.calls.map(([input, init]) => ({
			path: String(input).replace('http://localhost:3000', ''),
			method: String((init as RequestInit | undefined)?.method ?? 'GET'),
			body: (init as RequestInit | undefined)?.body
				? JSON.parse((init as RequestInit).body as string)
				: undefined,
		}))

	describe('set_loop_view', () => {
		it('pins an html file on the loop metadata', async () => {
			const result = await handlers.set_loop_view({
				workspace_id: wsId,
				loop_id: loopId,
				file_id: fileId,
			})

			const patch = calls().find((c) => c.method === 'PATCH')
			expect(patch?.path).toBe(`/api/objects/${loopId}`)
			expect(patch?.body).toEqual({ metadata: { view_file_id: fileId } })
			expect(JSON.parse(result.content[0].text ?? '{}')).toEqual({
				loop_id: loopId,
				view_file_id: fileId,
				changed: true,
				checklist: expect.any(Array),
			})
		})

		it('echoes a five-line checklist when a view is pinned, and none when it is cleared', async () => {
			const pinned = await handlers.set_loop_view({
				workspace_id: wsId,
				loop_id: loopId,
				file_id: fileId,
			})
			const checklist = JSON.parse(pinned.content[0].text ?? '{}').checklist as string[]
			expect(checklist).toHaveLength(5)
			expect(checklist.join(' ')).toMatch(/outcome/i)
			expect(checklist.join(' ')).toMatch(/maskin-sources/)

			const cleared = await handlers.set_loop_view({
				workspace_id: wsId,
				loop_id: loopId,
				file_id: null,
			})
			expect(JSON.parse(cleared.content[0].text ?? '{}').checklist).toBeUndefined()
		})

		it('tells agents how to build a good view in its description', () => {
			const { description } = tools.set_loop_view
			expect(description).toMatch(/outcome/i)
			expect(description).toMatch(/metrics/i)
			expect(description).toContain('maskin-sources')
			expect(description).toMatch(/three to five/i)
			expect(description.split('\n').length).toBeLessThanOrEqual(25)
		})

		it('is a no-op when the same file is already pinned', async () => {
			responses[`/api/objects/${loopId}`] = {
				id: loopId,
				type: 'loop',
				metadata: { view_file_id: fileId },
			}
			const result = await handlers.set_loop_view({
				workspace_id: wsId,
				loop_id: loopId,
				file_id: fileId,
			})

			expect(calls().some((c) => c.method === 'PATCH')).toBe(false)
			expect(JSON.parse(result.content[0].text ?? '{}').changed).toBe(false)
		})

		it('clears the view with a null file id without looking up a file', async () => {
			responses[`/api/objects/${loopId}`] = {
				id: loopId,
				type: 'loop',
				metadata: { view_file_id: fileId },
			}
			await handlers.set_loop_view({ workspace_id: wsId, loop_id: loopId, file_id: null })

			expect(calls().some((c) => c.path.startsWith('/api/files'))).toBe(false)
			expect(calls().find((c) => c.method === 'PATCH')?.body).toEqual({
				metadata: { view_file_id: null },
			})
		})

		it('clearing a loop that has no view changes nothing', async () => {
			await handlers.set_loop_view({ workspace_id: wsId, loop_id: loopId, file_id: null })
			expect(calls().some((c) => c.method === 'PATCH')).toBe(false)
		})

		it('rejects an object that is not a loop', async () => {
			responses[`/api/objects/${loopId}`] = { id: loopId, type: 'task', metadata: {} }
			await expect(
				handlers.set_loop_view({ workspace_id: wsId, loop_id: loopId, file_id: fileId }),
			).rejects.toThrow(/not 'loop'/)
			expect(calls().some((c) => c.method === 'PATCH')).toBe(false)
		})

		it('rejects a file that is not text/html', async () => {
			responses[`/api/files?ids=${fileId}`] = [{ id: fileId, mimeType: 'text/markdown' }]
			await expect(
				handlers.set_loop_view({ workspace_id: wsId, loop_id: loopId, file_id: fileId }),
			).rejects.toThrow(/not text\/html/)
			expect(calls().some((c) => c.method === 'PATCH')).toBe(false)
		})

		it('rejects a file that does not exist', async () => {
			responses[`/api/files?ids=${fileId}`] = []
			await expect(
				handlers.set_loop_view({ workspace_id: wsId, loop_id: loopId, file_id: fileId }),
			).rejects.toThrow(/not found/)
		})

		it('validates its input', () => {
			const schema = tools.set_loop_view.inputSchema
			expect(schema.safeParse({ loop_id: loopId, file_id: fileId }).success).toBe(true)
			expect(schema.safeParse({ loop_id: loopId, file_id: null }).success).toBe(true)
			expect(schema.safeParse({ loop_id: loopId }).success).toBe(false)
			expect(schema.safeParse({ loop_id: 'nope', file_id: null }).success).toBe(false)
			expect(schema.safeParse({ loop_id: loopId, file_id: 'nope' }).success).toBe(false)
		})
	})

	describe('query_data', () => {
		const result = {
			groups: [],
			total: { count: 2, value: 2 },
			rows_truncated: false,
			groups_truncated: false,
		}

		it('sends the spec to the data route as a read-only GET', async () => {
			responses['/api/data/query'] = result
			const out = await handlers.query_data({
				workspace_id: wsId,
				type: 'task',
				scope: loopId,
				group_by: 'status',
			})

			const [call] = calls()
			expect(call.method).toBe('GET')
			const spec = JSON.parse(decodeURIComponent(call.path.split('spec=')[1]))
			expect(spec).toEqual({ type: 'task', scope: loopId, group_by: 'status' })
			expect(JSON.parse(out.content[0].text ?? '{}')).toEqual(result)
		})

		it('defaults the scope to the workspace', () => {
			const parsed = tools.query_data.inputSchema.parse({ workspace_id: wsId, type: 'bet' })
			expect(parsed.scope).toBe('workspace')
		})

		it('validates the aggregation', () => {
			const schema = tools.query_data.inputSchema
			expect(
				schema.safeParse({ type: 'task', aggregate: { op: 'sum', field: 'points' } }).success,
			).toBe(true)
			expect(schema.safeParse({ type: 'task', aggregate: { op: 'sum' } }).success).toBe(false)
			expect(schema.safeParse({ type: 'task', group_by: 'metadata.team' }).success).toBe(true)
			expect(schema.safeParse({ type: 'task', group_by: 'title' }).success).toBe(false)
		})
	})
})
