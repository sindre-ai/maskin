import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the real create_objects, update_objects and update_loop handlers
// registered by createMcpServer, with fetch stubbed to echo large rows the way
// the API does, and checks a 42-item batch gets a reply under the token cap.
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
const BATCH = 42
const BIG_BODY = 'x'.repeat(5000)

const uuid = (n: number) => `33333333-3333-3333-3333-${String(n).padStart(12, '0')}`
const ids = Array.from({ length: BATCH }, (_, i) => uuid(i + 1))
const failingId = ids[BATCH - 1]

type Reply = { content: { text?: string }[] }
type Handler = (args: Record<string, unknown>) => Promise<Reply>

const objectRow = (id: string) => ({
	id,
	type: 'task',
	title: `Task ${id.slice(-3)}`,
	status: 'todo',
	content: BIG_BODY,
	metadata: { notes: BIG_BODY },
	workspaceId: wsId,
})

describe('bulk write replies', () => {
	let handlers: Record<string, Handler>
	let responseCap: typeof import('../response-cap')

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		handlers = {}
		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers[name as string] = h as Handler
		})
		// restoreAllMocks in afterEach clears the factory's implementation, so set it again.
		const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as never,
		)
		responseCap = await import('../response-cap')
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			webAppBaseUrl: 'https://maskin.io',
			telemetrySink: () => {},
		})
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const path = String(input).replace('http://localhost:3000', '').split('?')[0]
			const method = String(init?.method ?? 'GET')
			if (path === '/api/graph') {
				const body = JSON.parse(String(init?.body))
				return new Response(
					JSON.stringify({
						nodes: body.nodes.map((n: { $id: string; type: string; title: string }, i: number) => ({
							...objectRow(uuid(i + 1)),
							$id: n.$id,
							type: n.type,
							title: n.title,
						})),
						edges: [],
					}),
				)
			}
			if (path === '/api/relationships') return new Response(JSON.stringify({ id: 'rel' }))
			const match = path.match(/^\/api\/objects\/(.+)$/)
			if (match) {
				const id = match[1]
				if (id === loopId) {
					return new Response(
						JSON.stringify({
							id: loopId,
							type: 'loop',
							title: 'A loop',
							status: 'active',
							metadata: {},
						}),
					)
				}
				if (method === 'PATCH' && id === failingId) {
					return new Response(JSON.stringify({ error: 'Object is archived' }), { status: 409 })
				}
				return new Response(JSON.stringify(objectRow(id)))
			}
			return new Response(JSON.stringify([]))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const tokens = (reply: Reply) => responseCap.estimateResponseTokens(reply)
	const parse = (reply: Reply) => JSON.parse(reply.content[0].text ?? '{}')

	describe('update_objects', () => {
		it('keeps every id and error but drops the echoed rows for 42 updates', async () => {
			const reply = await handlers.update_objects({
				workspace_id: wsId,
				updates: ids.map((id) => ({ id, status: 'done' })),
				edges: [],
			})
			const body = parse(reply)

			expect(body.results).toHaveLength(BATCH)
			expect(body.results.map((r: { id: string }) => r.id)).toEqual(ids)
			for (const r of body.results) expect(r).not.toHaveProperty('result')
			const failed = body.results.find((r: { id: string }) => r.id === failingId)
			expect(failed.success).toBe(false)
			expect(failed.error).toContain('archived')
			expect(tokens(reply)).toBeLessThan(responseCap.getMaxResponseTokens())
		})

		it('keeps the full row for a single update', async () => {
			const reply = await handlers.update_objects({
				workspace_id: wsId,
				updates: [{ id: ids[0], status: 'done' }],
				edges: [],
			})
			const [first] = parse(reply).results
			expect(first.success).toBe(true)
			expect(first.result.content).toBe(BIG_BODY)
		})
	})

	describe('update_loop', () => {
		it('returns counts and ids, not the loop steps, for 42 added objects', async () => {
			const reply = await handlers.update_loop({
				workspace_id: wsId,
				id: loopId,
				add_object_ids: ids,
			})
			const body = parse(reply)

			expect(body.added_count).toBe(BATCH)
			expect(body.added_object_ids).toEqual(ids)
			expect(body).not.toHaveProperty('steps')
			expect(body.loop.id).toBe(loopId)
			expect(tokens(reply)).toBeLessThan(responseCap.getMaxResponseTokens())
		})

		it('keeps the loop row and steps for a single added object', async () => {
			const reply = await handlers.update_loop({
				workspace_id: wsId,
				id: loopId,
				add_object_ids: [ids[0]],
			})
			const body = parse(reply)
			expect(body).toHaveProperty('steps')
			expect(body).not.toHaveProperty('added_count')
		})
	})

	describe('create_objects', () => {
		const node = (i: number) => ({
			$id: `n${i}`,
			type: 'task',
			title: `Task ${i}`,
			content: BIG_BODY,
		})

		it('echoes id, type, title and url only for 42 created objects', async () => {
			const reply = await handlers.create_objects({
				workspace_id: wsId,
				nodes: Array.from({ length: BATCH }, (_, i) => node(i)),
				edges: [],
			})
			const body = parse(reply)

			expect(body.nodes).toHaveLength(BATCH)
			for (const n of body.nodes) {
				expect(Object.keys(n).sort()).toEqual(['$id', 'id', 'status', 'title', 'type', 'url'])
			}
			expect(tokens(reply)).toBeLessThan(responseCap.getMaxResponseTokens())
		})

		it('keeps the full rows for a single created object', async () => {
			const reply = await handlers.create_objects({
				workspace_id: wsId,
				nodes: [node(0)],
				edges: [],
			})
			expect(parse(reply).nodes[0].content).toBe(BIG_BODY)
		})
	})
})
