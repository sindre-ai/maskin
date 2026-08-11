import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK modules
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

import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
	HERO_CARD_TYPE_DEFAULTS,
	type HeroCardTypeAnnotation,
	buildContextLine,
	buildHeroCardObject,
	createMcpServer,
	pickResourceUri,
} from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	// Suppress fire-and-forget telemetry POSTs so tests counting fetch calls
	// see only the tool's own API call.
	telemetrySink: () => {},
}

// Tools whose `registerAppTool` calls are intentionally commented out in
// server.ts (notification MCP tools are temporarily hidden). Keep the tool
// *definitions* in `tools.ts` so re-enabling stays a one-line change.
const HIDDEN_TOOL_NAMES = new Set([
	'create_notification',
	'list_notifications',
	'get_notification',
	'update_notification',
	'delete_notification',
])

describe('createMcpServer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('registers a tool for every tool definition', () => {
		createMcpServer(config)
		const expectedCount = Object.keys(tools).filter((name) => !HIDDEN_TOOL_NAMES.has(name)).length
		expect(registerAppTool).toHaveBeenCalledTimes(expectedCount)
	})

	it('registers a UI resource for every defined resource', () => {
		createMcpServer(config)
		const resourceCount = vi.mocked(registerAppResource).mock.calls.length
		expect(resourceCount).toBeGreaterThan(0)
		// Verify all expected URIs are present
		const resourceUris = vi.mocked(registerAppResource).mock.calls.map((call) => call[2])
		const expectedUris = [
			'ui://maskin/objects',
			'ui://maskin/actors',
			'ui://maskin/workspaces',
			'ui://maskin/events',
			'ui://maskin/triggers',
			'ui://maskin/relationships',
			'ui://maskin/graph',
			'ui://maskin/schema',
			'ui://maskin/sessions',
			'ui://maskin/hero-card',
		]
		for (const uri of expectedUris) {
			expect(resourceUris).toContain(uri)
		}
		expect(resourceCount).toBe(expectedUris.length)
	})

	it('registers tools with correct names', () => {
		createMcpServer(config)
		const registeredNames = vi.mocked(registerAppTool).mock.calls.map((call) => call[1])
		expect(registeredNames).toContain('create_objects')
		expect(registeredNames).toContain('list_objects')
		expect(registeredNames).toContain('create_actor')
		expect(registeredNames).toContain('create_session')
		expect(registeredNames).toContain('run_agent')
		expect(registeredNames).toContain('create_trigger')
	})

	it('registers tools with descriptions', () => {
		createMcpServer(config)
		const toolDefs = vi.mocked(registerAppTool).mock.calls.map((call) => call[2])
		for (const def of toolDefs) {
			expect(def.description).toBeTruthy()
			expect(typeof def.description).toBe('string')
		}
	})

	it('registers tools with inputSchema shapes', () => {
		createMcpServer(config)
		const toolDefs = vi.mocked(registerAppTool).mock.calls.map((call) => call[2])
		for (const def of toolDefs) {
			expect(def.inputSchema).toBeDefined()
		}
	})

	it('registers every tool name from tools definitions', () => {
		createMcpServer(config)
		const registeredNames = vi.mocked(registerAppTool).mock.calls.map((call) => call[1])
		for (const name of Object.keys(tools)) {
			if (HIDDEN_TOOL_NAMES.has(name)) continue
			expect(registeredNames).toContain(name)
		}
	})
})

describe('tool handlers', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()

		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})

		createMcpServer(config)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	function mockFetchSuccess(data: unknown, headers?: Record<string, string>) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			headers: new Headers(headers ?? {}),
			json: () => Promise.resolve(data),
		} as Response)
	}

	function mockFetchError(status: number, body: string) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: false,
			status,
			text: () => Promise.resolve(body),
		} as Response)
	}

	describe('create_objects handler', () => {
		it('POSTs to /api/graph with body', async () => {
			const mockResult = { nodes: [{ id: '1' }], edges: [] }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_objects')
			const result = (await handler({
				nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
				edges: [],
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/graph',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer ank_testkey123',
						'X-Workspace-Id': 'ws-default-123',
					}),
				}),
			)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual(mockResult)
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({})

			const handler = getHandler('create_objects')
			await handler({
				workspace_id: 'ws-custom',
				nodes: [{ $id: 'x', type: 'task', status: 'todo' }],
				edges: [],
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/graph',
				expect.objectContaining({
					headers: expect.objectContaining({
						'X-Workspace-Id': 'ws-custom',
					}),
				}),
			)
		})

		it('attaches file_ids on a node by replaying each as an `attached` relationship', async () => {
			// First fetch: POST /api/graph returns the created node with its real
			// UUID + type. Subsequent fetches are the per-file relationship POSTs.
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							nodes: [{ $id: 'bet-1', id: 'real-bet-id', type: 'bet' }],
							edges: [],
						}),
				} as Response)
				.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ id: 'rel-1' }),
				} as Response)

			const handler = getHandler('create_objects')
			const result = (await handler({
				nodes: [
					{
						$id: 'bet-1',
						type: 'bet',
						status: 'active',
						file_ids: ['file-a', 'file-b'],
					},
				],
				edges: [],
			})) as { content: Array<{ text: string }> }

			// /api/graph body must NOT contain file_ids — it's an MCP-only field.
			const graphCall = vi
				.mocked(fetch)
				.mock.calls.find((c) => (c[0] as string).endsWith('/api/graph'))
			expect(graphCall).toBeDefined()
			const graphBody = JSON.parse((graphCall?.[1] as RequestInit).body as string)
			expect(graphBody.nodes[0].file_ids).toBeUndefined()

			// Two relationship POSTs, one per file, with target_type=file & type=attached.
			const relCalls = vi
				.mocked(fetch)
				.mock.calls.filter((c) => (c[0] as string).endsWith('/api/relationships'))
			expect(relCalls).toHaveLength(2)
			const relBodies = relCalls.map((c) => JSON.parse((c[1] as RequestInit).body as string))
			const targetIds = relBodies.map((b) => b.target_id).sort()
			expect(targetIds).toEqual(['file-a', 'file-b'])
			for (const body of relBodies) {
				expect(body.source_id).toBe('real-bet-id')
				expect(body.source_type).toBe('bet')
				expect(body.target_type).toBe('file')
				expect(body.type).toBe('attached')
			}

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.file_attachments).toHaveLength(2)
			expect(parsed.file_attachments.every((a: { success: boolean }) => a.success)).toBe(true)
		})

		it('omits file_attachments from the response when no file_ids were provided', async () => {
			mockFetchSuccess({ nodes: [{ $id: 'x', id: 'real-x', type: 'task' }], edges: [] })

			const handler = getHandler('create_objects')
			const result = (await handler({
				nodes: [{ $id: 'x', type: 'task', status: 'todo' }],
				edges: [],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.file_attachments).toBeUndefined()
		})
	})

	describe('get_objects handler', () => {
		it('GETs /api/objects/:id/graph for each ID', async () => {
			mockFetchSuccess({ id: '1', title: 'Test' })

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['id-1', 'id-2'] })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/id-1/graph',
				expect.anything(),
			)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/id-2/graph',
				expect.anything(),
			)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
		})

		it('default response is the lean core-fields projection — no graph context leaks to the model', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/bet-1/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'bet-1',
									type: 'bet',
									title: 'Bet 1',
									status: 'active',
									content: 'Full body text',
									metadata: { key: 'value' },
									workspaceId: 'ws-1',
								},
								relationships: [
									{
										id: 'rel-1',
										sourceId: 'bet-1',
										targetId: 'task-1',
										type: 'breaks_into',
										targetTitle: 'Task 1',
									},
								],
								connected_objects: [
									{ id: 'task-1', type: 'task', title: 'Task 1', status: 'todo' },
								],
								events: [{ id: 'evt-1', action: 'commented' }],
								files: [{ id: 'file-1', name: 'note.md' }],
							}),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['bet-1'] })) as {
				content: Array<{ text: string }>
				structuredContent: {
					heroCard: { object?: { id: string }; relationships?: unknown }
					results: Array<{ id: string; success: boolean }>
					objects: Array<{
						object: Record<string, unknown>
						relationships?: unknown
						connected_objects?: unknown
						events?: unknown
						files?: unknown
					}>
				}
			}

			expect(result.structuredContent.heroCard.object?.id).toBe('bet-1')
			expect(result.structuredContent.heroCard.relationships).toBeUndefined()

			// Canonical object body lives at `objects[]` — one entry per successful id,
			// carrying only `object` (no relationships/connected_objects/events/files).
			const first = result.structuredContent.objects[0]
			expect(Object.keys(first).sort()).toEqual(['object'])
			// Per-object payload: exactly the core six (url is omitted when
			// webAppBaseUrl isn't configured on the test rig — the injection is
			// covered separately in the `url field injection` suite).
			expect(Object.keys(first.object).sort()).toEqual([
				'contextLine',
				'id',
				'status',
				'title',
				'type',
				'workspaceId',
			])
			expect(first.object.content).toBeUndefined()
			// content[0].text is what the LLM actually reads — must also carry the lean shape.
			const parsed = JSON.parse(result.content[0].text) as Array<{
				result: { object: Record<string, unknown> }
			}>
			expect(Object.keys(parsed[0].result.object).sort()).toEqual([
				'contextLine',
				'id',
				'status',
				'title',
				'type',
				'workspaceId',
			])
		})

		it('opts back into extra blocks when include: is passed', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/bet-2/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: { id: 'bet-2', type: 'bet', title: 'Bet 2', status: 'active' },
								relationships: [
									{
										id: 'rel-2',
										sourceId: 'bet-2',
										targetId: 'task-2',
										type: 'breaks_into',
										targetTitle: 'Task 2',
									},
								],
								connected_objects: [
									{ id: 'task-2', type: 'task', title: 'Task 2', status: 'todo' },
								],
							}),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({
				ids: ['bet-2'],
				include: ['relationships', 'connected_objects'],
			})) as {
				structuredContent: {
					objects: Array<{ relationships?: unknown[]; connected_objects?: unknown[] }>
				}
			}

			expect(result.structuredContent.objects[0].relationships).toHaveLength(1)
			expect(result.structuredContent.objects[0].connected_objects).toHaveLength(1)
		})

		it('emits each object body exactly once across heroCard, results, and objects', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				const match = urlStr.match(/\/api\/objects\/([^/]+)\/graph/)
				const id = match?.[1] ?? 'unknown'
				return {
					ok: true,
					json: () =>
						Promise.resolve({
							object: { id, type: 'bet', title: `Bet ${id}`, status: 'active' },
							relationships: [],
							connected_objects: [],
						}),
				} as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['bet-a', 'bet-b'] })) as {
				structuredContent: {
					heroCard: {
						object?: { id: string }
						objects?: Array<{ id: string; relationships?: unknown; connected_objects?: unknown }>
					}
					results: Array<{ id: string; success: boolean; result?: unknown }>
					objects: Array<{ object: { id: string }; relationships?: unknown }>
				}
			}

			// heroCard entries must be the lean HeroCardObject shape — no full body.
			const heroEntries = result.structuredContent.heroCard.objects ?? []
			for (const entry of heroEntries) {
				expect(entry.relationships).toBeUndefined()
				expect(entry.connected_objects).toBeUndefined()
			}

			// results[] is now a per-id envelope — no object body nested under .result.
			for (const r of result.structuredContent.results) {
				expect(r).not.toHaveProperty('result')
				expect(typeof r.id).toBe('string')
				expect(typeof r.success).toBe('boolean')
			}

			// objects[] is the canonical body location — exactly one entry per id.
			const bodyIds = result.structuredContent.objects.map((o) => o.object.id)
			expect(bodyIds).toEqual(['bet-a', 'bet-b'])
			expect(new Set(bodyIds).size).toBe(bodyIds.length)
		})
	})

	describe('list_objects handler', () => {
		it('GETs /api/objects with query params', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({ type: 'task', limit: 10, offset: 5 })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('/api/objects?')
			expect(calledUrl).toContain('type=task')
			expect(calledUrl).toContain('limit=10')
			expect(calledUrl).toContain('offset=5')
		})

		it('forwards updated_before and updated_after to the route', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({
				updated_before: '2026-06-30T12:00:00.000Z',
				updated_after: '2026-06-29T12:00:00.000Z',
			})

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('updated_before=2026-06-30T12%3A00%3A00.000Z')
			expect(calledUrl).toContain('updated_after=2026-06-29T12%3A00%3A00.000Z')
		})

		// Tool-level proof that sort=updated_at_asc surfaces rows in ascending
		// updated_at order: the dispatcher routes the MCP sort to the route's
		// (sort=updatedAt, order=asc) contract, and the mocked route returns
		// rows in that order. The route's actual ordering is covered by T2's
		// integration tests against real Postgres.
		it('maps sort=updated_at_asc to sort=updatedAt&order=asc and returns rows in that order', async () => {
			const ascRows = [
				{ id: 'oldest', updatedAt: '2026-06-20T00:00:00.000Z' },
				{ id: 'middle', updatedAt: '2026-06-25T00:00:00.000Z' },
				{ id: 'newest', updatedAt: '2026-06-30T00:00:00.000Z' },
			]
			mockFetchSuccess(ascRows)

			const handler = getHandler('list_objects')
			const result = (await handler({ sort: 'updated_at_asc' })) as {
				structuredContent: { objects: Array<{ id: string }> }
			}

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('sort=updatedAt')
			expect(calledUrl).toContain('order=asc')
			expect(result.structuredContent.objects.map((o) => o.id)).toEqual([
				'oldest',
				'middle',
				'newest',
			])
		})

		it('maps sort=updated_at_desc to sort=updatedAt&order=desc', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({ sort: 'updated_at_desc' })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('sort=updatedAt')
			expect(calledUrl).toContain('order=desc')
		})

		it('omits sort + order when no sort is passed (additive only)', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({ type: 'task' })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).not.toContain('sort=')
			expect(calledUrl).not.toContain('order=')
		})

		it('forwards each metadata_eq entry as metadata.<field>=<value>', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({ metadata_eq: { segment: 'enterprise', confidence: 'high' } })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('metadata.segment=enterprise')
			expect(calledUrl).toContain('metadata.confidence=high')
		})

		it('omits metadata.* params when metadata_eq is not supplied', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({ type: 'task' })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).not.toContain('metadata.')
		})

		it('forwards include_archived=true to the route when opted in', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({ include_archived: true })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('include_archived=true')
		})

		it('omits include_archived from the URL when the flag defaults to false', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_objects')
			await handler({})

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).not.toContain('include_archived=')
		})
	})

	describe('search_objects handler', () => {
		it('forwards driver_id as driver and updated_after to the route', async () => {
			mockFetchSuccess([])
			const driverId = '550e8400-e29b-41d4-a716-446655440000'

			const handler = getHandler('search_objects')
			await handler({
				q: 'bet',
				driver_id: driverId,
				updated_after: '2026-06-29T12:00:00.000Z',
			})

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('/api/objects/search?')
			expect(calledUrl).toContain('q=bet')
			expect(calledUrl).toContain(`driver=${driverId}`)
			expect(calledUrl).toContain('updated_after=2026-06-29T12%3A00%3A00.000Z')
		})

		it('omits driver and updated_after when the params are not supplied', async () => {
			mockFetchSuccess([])

			const handler = getHandler('search_objects')
			await handler({ q: 'bet' })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('/api/objects/search?')
			expect(calledUrl).toContain('q=bet')
			expect(calledUrl).not.toContain('driver=')
			expect(calledUrl).not.toContain('updated_after=')
		})

		it('composes driver_id and updated_after additively with type + q', async () => {
			mockFetchSuccess([])
			const driverId = '550e8400-e29b-41d4-a716-446655440000'

			const handler = getHandler('search_objects')
			await handler({
				q: 'onboarding',
				type: 'task',
				driver_id: driverId,
				updated_after: '2026-06-29T12:00:00.000Z',
			})

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('q=onboarding')
			expect(calledUrl).toContain('type=task')
			expect(calledUrl).toContain(`driver=${driverId}`)
			expect(calledUrl).toContain('updated_after=2026-06-29T12%3A00%3A00.000Z')
		})

		it('forwards each metadata_eq entry as metadata.<field>=<value>', async () => {
			mockFetchSuccess([])

			const handler = getHandler('search_objects')
			await handler({ q: 'bet', metadata_eq: { promotion_mode: 'human_approved' } })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('q=bet')
			expect(calledUrl).toContain('metadata.promotion_mode=human_approved')
		})

		it('omits metadata.* params when metadata_eq is not supplied', async () => {
			mockFetchSuccess([])

			const handler = getHandler('search_objects')
			await handler({ q: 'bet' })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).not.toContain('metadata.')
		})

		it('forwards include_archived=true to the route when opted in', async () => {
			mockFetchSuccess([])

			const handler = getHandler('search_objects')
			await handler({ q: 'bet', include_archived: true })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).toContain('include_archived=true')
		})

		it('omits include_archived from the URL when the flag defaults to false', async () => {
			mockFetchSuccess([])

			const handler = getHandler('search_objects')
			await handler({ q: 'bet' })

			const calledUrl = vi.mocked(fetch).mock.calls[0][0] as string
			expect(calledUrl).not.toContain('include_archived=')
		})
	})

	describe('list_sessions handler', () => {
		it('forwards updated_before and updated_after to the route', async () => {
			mockFetchSuccess([])

			const handler = getHandler('list_sessions')
			await handler({
				updated_before: '2026-06-30T12:00:00.000Z',
				updated_after: '2026-06-29T12:00:00.000Z',
			})

			const sessionsCall = vi
				.mocked(fetch)
				.mock.calls.find((c) => (c[0] as string).includes('/api/sessions?'))
			expect(sessionsCall).toBeDefined()
			const calledUrl = sessionsCall?.[0] as string
			expect(calledUrl).toContain('updated_before=2026-06-30T12%3A00%3A00.000Z')
			expect(calledUrl).toContain('updated_after=2026-06-29T12%3A00%3A00.000Z')
		})
	})

	describe('update_objects handler — file attachments', () => {
		it('attaches files via `attach_file_ids` as `attached` relationships', async () => {
			// PATCH the object, GET (per file, returns empty → not yet attached),
			// then POST a relationship per file.
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
				const method = (init as RequestInit | undefined)?.method ?? 'GET'
				const urlStr = url as string
				if (method === 'PATCH') {
					return {
						ok: true,
						json: () => Promise.resolve({ id: 'obj-1', type: 'bet' }),
					} as Response
				}
				if (method === 'GET' && urlStr.includes('/api/relationships?')) {
					return { ok: true, json: () => Promise.resolve([]) } as Response
				}
				return { ok: true, json: () => Promise.resolve({ id: 'rel-1' }) } as Response
			})

			const handler = getHandler('update_objects')
			const result = (await handler({
				updates: [
					{
						id: '11111111-1111-1111-1111-111111111111',
						title: 'New title',
						attach_file_ids: [
							'22222222-2222-2222-2222-222222222222',
							'33333333-3333-3333-3333-333333333333',
						],
					},
				],
			})) as { content: Array<{ text: string }> }

			const relPosts = vi
				.mocked(fetch)
				.mock.calls.filter(
					(c) =>
						(c[0] as string).endsWith('/api/relationships') &&
						((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST',
				)
			expect(relPosts).toHaveLength(2)
			for (const call of relPosts) {
				const body = JSON.parse((call[1] as RequestInit).body as string)
				expect(body.source_id).toBe('11111111-1111-1111-1111-111111111111')
				// Real type from the PATCH response, not the generic 'object' — matches
				// what create_objects and the web UI write.
				expect(body.source_type).toBe('bet')
				expect(body.target_type).toBe('file')
				expect(body.type).toBe('attached')
			}

			const parsed = JSON.parse(result.content[0].text)
			const attachments = parsed.filter((e: { type: string }) => e.type === 'file_attachment')
			expect(attachments).toHaveLength(2)
			expect(attachments.every((a: { success: boolean }) => a.success)).toBe(true)
			expect(attachments.every((a: { skipped?: boolean }) => !a.skipped)).toBe(true)
		})

		it('skips a duplicate attach as a success+skipped no-op without POSTing', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
				const method = (init as RequestInit | undefined)?.method ?? 'GET'
				const urlStr = url as string
				if (method === 'GET' && urlStr.includes('/api/relationships?')) {
					return {
						ok: true,
						json: () => Promise.resolve([{ id: 'rel-existing', targetType: 'file' }]),
					} as Response
				}
				if (method === 'GET' && urlStr.includes('/api/objects/')) {
					return { ok: true, json: () => Promise.resolve({ id: 'obj-1', type: 'bet' }) } as Response
				}
				// Any unexpected call (e.g. a POST) returns OK so we can detect it
				// via the call-count assertion below rather than crashing the test.
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})

			const handler = getHandler('update_objects')
			const result = (await handler({
				updates: [
					{
						id: '11111111-1111-1111-1111-111111111111',
						attach_file_ids: ['22222222-2222-2222-2222-222222222222'],
					},
				],
			})) as { content: Array<{ text: string }> }

			const relPosts = vi
				.mocked(fetch)
				.mock.calls.filter(
					(c) =>
						(c[0] as string).endsWith('/api/relationships') &&
						((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST',
				)
			expect(relPosts).toHaveLength(0)

			const parsed = JSON.parse(result.content[0].text)
			const attachments = parsed.filter((e: { type: string }) => e.type === 'file_attachment')
			expect(attachments).toHaveLength(1)
			expect(attachments[0].success).toBe(true)
			expect(attachments[0].skipped).toBe(true)
		})

		it('skips the PATCH when an update only contains attach_file_ids', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
				const method = (init as RequestInit | undefined)?.method ?? 'GET'
				const urlStr = url as string
				if (method === 'GET' && urlStr.includes('/api/relationships?')) {
					return { ok: true, json: () => Promise.resolve([]) } as Response
				}
				if (method === 'GET' && urlStr.includes('/api/objects/')) {
					return {
						ok: true,
						json: () => Promise.resolve({ id: 'obj-1', type: 'task' }),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve({ id: 'rel-1' }) } as Response
			})

			const handler = getHandler('update_objects')
			await handler({
				updates: [
					{
						id: '11111111-1111-1111-1111-111111111111',
						attach_file_ids: ['22222222-2222-2222-2222-222222222222'],
					},
				],
			})

			// No PATCH — the handler must instead GET the object once to learn its
			// type, then POST the relationship using that type as source_type.
			const patchCalls = vi
				.mocked(fetch)
				.mock.calls.filter((c) => ((c[1] as RequestInit).method ?? 'GET') === 'PATCH')
			expect(patchCalls).toHaveLength(0)

			const relPost = vi
				.mocked(fetch)
				.mock.calls.find(
					(c) =>
						(c[0] as string).endsWith('/api/relationships') &&
						((c[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST',
				)
			expect(relPost).toBeDefined()
			const body = JSON.parse((relPost?.[1] as RequestInit).body as string)
			expect(body.source_type).toBe('task')
		})

		it('detaches files via `detach_file_ids` by looking up the relationship and deleting it', async () => {
			vi.spyOn(globalThis, 'fetch')
				// GET /api/relationships?source_id=...&target_id=...&type=attached
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([{ id: 'rel-99', targetType: 'file' }]),
				} as Response)
				// DELETE /api/relationships/rel-99
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ deleted: true }),
				} as Response)

			const handler = getHandler('update_objects')
			const result = (await handler({
				updates: [
					{
						id: '11111111-1111-1111-1111-111111111111',
						detach_file_ids: ['22222222-2222-2222-2222-222222222222'],
					},
				],
			})) as { content: Array<{ text: string }> }

			const calls = vi.mocked(fetch).mock.calls
			expect(calls[0][0]).toMatch(/\/api\/relationships\?.*type=attached/)
			expect(calls[1][0]).toBe('http://localhost:3000/api/relationships/rel-99')
			expect((calls[1][1] as RequestInit).method).toBe('DELETE')

			const parsed = JSON.parse(result.content[0].text)
			const detachments = parsed.filter((e: { type: string }) => e.type === 'file_detachment')
			expect(detachments).toHaveLength(1)
			expect(detachments[0].success).toBe(true)
		})

		it('reports a clear error when detach target has no matching attachment', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve([]),
			} as Response)

			const handler = getHandler('update_objects')
			const result = (await handler({
				updates: [
					{
						id: '11111111-1111-1111-1111-111111111111',
						detach_file_ids: ['22222222-2222-2222-2222-222222222222'],
					},
				],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed[0].type).toBe('file_detachment')
			expect(parsed[0].success).toBe(false)
			expect(parsed[0].error).toMatch(/no attached relationship/i)
		})
	})

	describe('delete_object handler', () => {
		it('DELETEs /api/objects/:id', async () => {
			mockFetchSuccess({})

			const handler = getHandler('delete_object')
			await handler({ id: 'obj-123' })

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/obj-123',
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('create_actor handler', () => {
		it('POSTs to /api/actors with skipAuth', async () => {
			mockFetchSuccess({ id: 'actor-new', name: 'Bot', type: 'agent' })

			const handler = getHandler('create_actor')
			await handler({ type: 'agent', name: 'Bot' })

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/actors',
				expect.objectContaining({ method: 'POST' }),
			)
		})

		it('adds to workspace when workspace_id provided', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'actor-new' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({}),
				} as Response)

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				workspace_id: 'ws-123',
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenLastCalledWith(
				'http://localhost:3000/api/workspaces/ws-123/members',
				expect.objectContaining({ method: 'POST' }),
			)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.workspace_id).toBe('ws-123')
			expect(parsed.role).toBe('member')
		})

		it('attaches skills on creation in a single batched call', async () => {
			const skillId1 = '660e8400-e29b-41d4-a716-446655440001'
			const skillId2 = '660e8400-e29b-41d4-a716-446655440002'
			const mockSkill1 = { id: skillId1, name: 'My Skill' }
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ id: 'actor-new' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({}),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve([
							{ workspaceSkillId: skillId1, success: true, skill: mockSkill1 },
							{ workspaceSkillId: skillId2, success: false, error: 'Workspace skill not found' },
						]),
				} as Response)

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				workspace_id: 'ws-123',
				attach_skill_ids: [skillId1, skillId2],
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(3)
			expect(fetch).toHaveBeenLastCalledWith(
				'http://localhost:3000/api/actors/actor-new/workspace-skills/batch',
				expect.objectContaining({ method: 'POST' }),
			)
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.attached_skills).toEqual([
				mockSkill1,
				{ skill_id: skillId2, error: 'Workspace skill not found' },
			])
			expect(parsed.partial_failure).toBe(true)
		})

		it('marks all requested skills failed when the batch call itself throws', async () => {
			const skillId1 = '660e8400-e29b-41d4-a716-446655440001'
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ id: 'actor-new' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({}),
				} as Response)
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					text: () => Promise.resolve('Internal error'),
				} as Response)

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				workspace_id: 'ws-123',
				attach_skill_ids: [skillId1],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.partial_failure).toBe(true)
			expect(parsed.attached_skills[0].skill_id).toBe(skillId1)
			expect(typeof parsed.attached_skills[0].error).toBe('string')
		})

		it('chunks more than 50 skill ids into multiple batched calls and merges results in order', async () => {
			const skillIds = Array.from(
				{ length: 51 },
				(_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
			)
			const chunk1 = skillIds.slice(0, 50)
			const chunk2 = skillIds.slice(50)

			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ id: 'actor-new' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({}),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve(
							chunk1.map((id) => ({ workspaceSkillId: id, success: true, skill: { id } })),
						),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve(
							chunk2.map((id) => ({ workspaceSkillId: id, success: true, skill: { id } })),
						),
				} as Response)

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				workspace_id: 'ws-123',
				attach_skill_ids: skillIds,
			})) as { content: Array<{ text: string }> }

			// create actor + add member + one batch call per 50-id chunk (51 ids -> 2 chunks).
			expect(fetch).toHaveBeenCalledTimes(4)

			const batchCalls = vi.mocked(fetch).mock.calls.slice(2)
			expect(batchCalls).toHaveLength(2)
			const sentChunks = batchCalls.map(
				(call) =>
					(JSON.parse(call[1]?.body as string) as { workspaceSkillIds: string[] })
						.workspaceSkillIds,
			)
			expect(sentChunks[0]).toEqual(chunk1)
			expect(sentChunks[1]).toEqual(chunk2)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.attached_skills).toEqual(skillIds.map((id) => ({ id })))
		})

		it('merges results across chunks when one chunk succeeds and another throws', async () => {
			const skillIds = Array.from(
				{ length: 51 },
				(_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
			)
			const chunk1 = skillIds.slice(0, 50)
			const chunk2 = skillIds.slice(50)

			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ id: 'actor-new' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({}),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve(
							chunk1.map((id) => ({ workspaceSkillId: id, success: true, skill: { id } })),
						),
				} as Response)
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					text: () => Promise.resolve('Internal error'),
				} as Response)

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				workspace_id: 'ws-123',
				attach_skill_ids: skillIds,
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.partial_failure).toBe(true)
			expect(parsed.attached_skills.slice(0, 50)).toEqual(chunk1.map((id) => ({ id })))
			expect(parsed.attached_skills[50].skill_id).toBe(chunk2[0])
			expect(typeof parsed.attached_skills[50].error).toBe('string')
		})

		it('skips skill attachment and explains why when auto_create_workspace is combined with attach_skill_ids', async () => {
			const skillId1 = '660e8400-e29b-41d4-a716-446655440001'
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: 'actor-new', workspace_id: 'ws-auto' }),
			} as Response)

			const handler = getHandler('create_actor')
			const result = (await handler({
				type: 'agent',
				name: 'Bot',
				auto_create_workspace: true,
				attach_skill_ids: [skillId1],
			})) as { content: Array<{ text: string }> }

			// Only the create-actor call fires — no membership call (the backend
			// already added the actor to its auto-created workspace) and no batch
			// attach call (the requested skills can't live in a workspace that was
			// just created empty).
			expect(fetch).toHaveBeenCalledTimes(1)

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.attached_skills).toBeUndefined()
			expect(parsed.partial_failure).toBeUndefined()
			expect(parsed.skills_not_attached_reason).toMatch(/auto_create_workspace/)
		})
	})

	describe('get_objects handler (partial failure)', () => {
		it('returns success false for failed IDs without rejecting', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'id-1', title: 'OK' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: false,
					status: 404,
					text: () => Promise.resolve('Not found'),
				} as Response)

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['id-1', 'id-2'] })) as {
				content: Array<{ text: string }>
			}

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
			expect(parsed[0].result).toEqual({ id: 'id-1', title: 'OK' })
			expect(parsed[1].success).toBe(false)
			expect(parsed[1].error).toContain('API error 404')
		})
	})

	describe('create_session handler', () => {
		it('POSTs to /api/sessions', async () => {
			mockFetchSuccess({ id: 'session-1', status: 'pending' })

			const handler = getHandler('create_session')
			await handler({
				actor_id: 'actor-1',
				action_prompt: 'Fix bugs',
				auto_start: true,
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/sessions',
				expect.objectContaining({ method: 'POST' }),
			)
		})
	})

	describe('run_agent handler', () => {
		it('creates session, polls until completed, fetches logs', async () => {
			vi.useFakeTimers()
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				// 1. POST /api/sessions — create session
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-1', status: 'pending' }),
				} as Response)
				// 2. GET /api/sessions/sess-1 — first poll (running)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-1', status: 'running' }),
				} as Response)
				// 3. GET /api/sessions/sess-1 — second poll (completed)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-1', status: 'completed' }),
				} as Response)
				// 4. GET /api/sessions/sess-1/logs — fetch logs
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([{ message: 'Done' }]),
				} as Response)

			const handler = getHandler('run_agent')
			const resultPromise = handler({
				actor_id: 'actor-1',
				action_prompt: 'Fix bugs',
				poll_interval_seconds: 5,
				timeout_seconds: 60,
			})

			// Advance through the two polling intervals
			await vi.advanceTimersByTimeAsync(5000) // first poll → running
			await vi.advanceTimersByTimeAsync(5000) // second poll → completed

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text)

			expect(parsed.session.status).toBe('completed')
			expect(parsed.logs).toEqual([{ message: 'Done' }])

			// Verify call sequence: create → poll → poll → logs
			expect(fetchSpy).toHaveBeenCalledTimes(4)
			expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:3000/api/sessions')
			expect(fetchSpy.mock.calls[1][0]).toBe('http://localhost:3000/api/sessions/sess-1')
			expect(fetchSpy.mock.calls[2][0]).toBe('http://localhost:3000/api/sessions/sess-1')
			expect(fetchSpy.mock.calls[3][0]).toBe(
				'http://localhost:3000/api/sessions/sess-1/logs?limit=500',
			)
		})

		it('stops polling when deadline is reached', async () => {
			vi.useFakeTimers()
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				// 1. POST /api/sessions — create session
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-2', status: 'pending' }),
				} as Response)
				// All subsequent polls return 'running' (never terminal)
				.mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-2', status: 'running' }),
				} as Response)

			const handler = getHandler('run_agent')
			// Very short timeout (10s) with 5s poll interval = at most 2 polls before deadline
			const resultPromise = handler({
				actor_id: 'actor-1',
				action_prompt: 'Long task',
				poll_interval_seconds: 5,
				timeout_seconds: 10,
			})

			// Advance past deadline
			await vi.advanceTimersByTimeAsync(5000) // first poll
			await vi.advanceTimersByTimeAsync(5000) // second poll
			await vi.advanceTimersByTimeAsync(5000) // past deadline

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text)

			// Session should still show 'running' since it never reached terminal
			expect(parsed.session.status).toBe('running')
			// Should have fetched logs even though it timed out
			expect(parsed.logs).toBeDefined()
		})

		it('uses default poll_interval and timeout when not specified', async () => {
			vi.useFakeTimers()
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-3', status: 'pending' }),
				} as Response)
				// Immediate completion on first poll
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'sess-3', status: 'completed' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([]),
				} as Response)

			const handler = getHandler('run_agent')
			const resultPromise = handler({
				actor_id: 'actor-1',
				action_prompt: 'Quick task',
			})

			// Default poll interval is 5s
			await vi.advanceTimersByTimeAsync(5000)

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.session.status).toBe('completed')
		})
	})

	describe('get_started handler', () => {
		const workspace = { id: 'ws-1', name: 'My Workspace' }
		const loops = [
			{
				id: 'loop-dev-1',
				name: 'Development',
				description: 'Product team shipping software',
				use_case: 'development',
				item_types: ['actor', 'trigger'],
			},
			{
				id: 'loop-growth-1',
				name: 'Growth',
				description: 'Founder running a launch pipeline',
				use_case: 'growth',
				item_types: ['actor'],
			},
		]

		it('lists marketplace loops when no loop_id is given', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ loops }),
				} as Response)

			const handler = getHandler('get_started')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('My Workspace')
			expect(text).toContain('Development')
			expect(text).toContain('Growth')
			expect(text).toContain('loop-dev-1')
			expect(text).toContain('loop_id')
			expect(text).toContain('confirm: true')
		})

		it('returns empty-marketplace message when marketplace has no loops', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ loops: [] }),
				} as Response)

			const handler = getHandler('get_started')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('marketplace')
			expect(text).not.toContain('loop_id')
		})

		it('installs loop when loop_id and confirm: true are provided', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							objectId: 'loop-obj-1',
							provisioned: { actors: 3, triggers: 5, skills: 2 },
						}),
				} as Response)
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ connected: false }),
				} as Response)

			const handler = getHandler('get_started')
			const result = (await handler({
				loop_id: 'loop-dev-1',
				confirm: true,
			})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('installed')
			expect(text).toContain('My Workspace')
			expect(text).toContain('/ws-1/loops/loop-obj-1')

			const installCall = fetchSpy.mock.calls.find(
				([u, opts]) =>
					(opts as RequestInit)?.method === 'POST' &&
					(u as string).includes('/api/installed-loops'),
			)
			if (!installCall) throw new Error('install call not found')
			const installBody = JSON.parse((installCall[1] as RequestInit).body as string)
			expect(installBody.loopId).toBe('loop-dev-1')
			expect(installBody.workspaceId).toBe('ws-1')
		})

		it('renames workspace before installing when workspace_name is provided', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1', name: 'Acme' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ provisioned: { actors: 2, triggers: 3, skills: 0 } }),
				} as Response)
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ connected: false }),
				} as Response)

			const handler = getHandler('get_started')
			await handler({ loop_id: 'loop-dev-1', confirm: true, workspace_name: 'Acme' })

			const patchCall = fetchSpy.mock.calls.find(
				([u, opts]) =>
					(opts as RequestInit)?.method === 'PATCH' &&
					(u as string).includes('/api/workspaces/ws-1'),
			)
			if (!patchCall) throw new Error('patch call not found')
			const patchBody = JSON.parse((patchCall[1] as RequestInit).body as string)
			expect(patchBody).toEqual({ name: 'Acme' })
		})

		it('degrades gracefully when workspaces fetch fails', async () => {
			vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

			const handler = getHandler('get_started')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain("can't reach your workspace")
			expect(text).toContain('create_actor')
		})
	})

	describe('error handling', () => {
		it('throws with API error message', async () => {
			mockFetchError(
				400,
				JSON.stringify({
					error: {
						message: 'Validation failed',
						details: [{ field: 'name', message: 'Required' }],
					},
				}),
			)

			const handler = getHandler('list_objects')
			await expect(handler({})).rejects.toThrow('API error 400')
		})

		it('throws with suggestion when available', async () => {
			mockFetchError(
				401,
				JSON.stringify({
					error: { message: 'Unauthorized', suggestion: 'Check your API key' },
				}),
			)

			const handler = getHandler('list_objects')
			await expect(handler({})).rejects.toThrow('Hint: Check your API key')
		})

		it('throws with raw text for non-JSON error', async () => {
			mockFetchError(500, 'Internal Server Error')

			const handler = getHandler('list_objects')
			await expect(handler({})).rejects.toThrow('Internal Server Error')
		})
	})

	describe('auth validation', () => {
		it('throws when no API key configured', async () => {
			const noKeyHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				noKeyHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, apiKey: '' })

			const handler = noKeyHandlers.get('list_objects')
			if (!handler) throw new Error('Handler list_objects not registered')
			await expect(handler({})).rejects.toThrow('Not authenticated')
		})

		it('hosted-MCP setup hint mentions the Authorization header, not env vars', async () => {
			const httpHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				httpHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, apiKey: '', transport: 'http' })

			const handler = httpHandlers.get('list_objects')
			if (!handler) throw new Error('Handler list_objects not registered')
			await expect(handler({})).rejects.toThrow(/Authorization: Bearer/)
		})

		it('hosted-MCP missing-workspace hint mentions the X-Workspace-Id header', async () => {
			const httpHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				httpHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, defaultWorkspaceId: '', transport: 'http' })

			const handler = httpHandlers.get('list_objects')
			if (!handler) throw new Error('Handler list_objects not registered')
			await expect(handler({})).rejects.toThrow(/X-Workspace-Id/)
		})
	})

	// Notification MCP tools are temporarily hidden — see server.ts. Skip the
	// handler tests until the tools are re-enabled.
	describe.skip('create_notification handler', () => {
		it('passes native array metadata.actions through unchanged', async () => {
			const mockResult = { id: 'notif-1' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_notification')
			const actions = [{ label: 'Approve', response: 'approved' }]
			await handler({
				type: 'needs_input',
				title: 'Test',
				source_actor_id: '00000000-0000-0000-0000-000000000001',
				metadata: { actions },
			})

			const fetchCall = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse(fetchCall[1]?.body as string)
			expect(body.metadata.actions).toEqual(actions)
		})

		it('auto-parses JSON string metadata.actions into an array', async () => {
			const mockResult = { id: 'notif-1' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_notification')
			const actions = [{ label: 'Approve', response: 'approved' }]
			await handler({
				type: 'needs_input',
				title: 'Test',
				source_actor_id: '00000000-0000-0000-0000-000000000001',
				metadata: { actions: JSON.stringify(actions) },
			})

			const fetchCall = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse(fetchCall[1]?.body as string)
			expect(body.metadata.actions).toEqual(actions)
		})

		it('throws when metadata.actions is an invalid JSON string', async () => {
			const handler = getHandler('create_notification')
			await expect(
				handler({
					type: 'needs_input',
					title: 'Test',
					source_actor_id: '00000000-0000-0000-0000-000000000001',
					metadata: { actions: 'not valid json' },
				}),
			).rejects.toThrow('metadata.actions must be a valid JSON array or native array')
		})

		it('throws when metadata.actions is a JSON string of a non-array', async () => {
			const handler = getHandler('create_notification')
			await expect(
				handler({
					type: 'needs_input',
					title: 'Test',
					source_actor_id: '00000000-0000-0000-0000-000000000001',
					metadata: { actions: '{"label": "test"}' },
				}),
			).rejects.toThrow('metadata.actions must be an array')
		})

		it('throws when metadata.actions is a non-array non-string', async () => {
			const handler = getHandler('create_notification')
			await expect(
				handler({
					type: 'needs_input',
					title: 'Test',
					source_actor_id: '00000000-0000-0000-0000-000000000001',
					metadata: { actions: 42 },
				}),
			).rejects.toThrow('metadata.actions must be an array')
		})

		it('works when metadata has no actions field', async () => {
			const mockResult = { id: 'notif-1' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_notification')
			await handler({
				type: 'needs_input',
				title: 'Test',
				source_actor_id: '00000000-0000-0000-0000-000000000001',
				metadata: { urgency_label: 'high' },
			})

			expect(fetch).toHaveBeenCalledTimes(1)
		})
	})

	describe('workspace skills handlers', () => {
		describe('list_workspace_skills handler', () => {
			it('GETs /api/workspaces/:id/skills with the default workspace', async () => {
				mockFetchSuccess([
					{ id: 's1', name: 'bug-fix', description: 'Bug-fix skill', sizeBytes: 42 },
				])

				const handler = getHandler('list_workspace_skills')
				const result = (await handler({})) as { content: Array<{ text: string }> }

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills',
					expect.objectContaining({
						method: 'GET',
						headers: expect.objectContaining({
							Authorization: 'Bearer ank_testkey123',
							'X-Workspace-Id': 'ws-default-123',
						}),
					}),
				)

				const parsed = JSON.parse(result.content[0].text)
				expect(parsed).toHaveLength(1)
				expect(parsed[0].name).toBe('bug-fix')
			})

			it('uses workspace_id from args over default', async () => {
				mockFetchSuccess([])
				const handler = getHandler('list_workspace_skills')
				await handler({ workspace_id: 'ws-custom' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-custom/skills',
					expect.objectContaining({
						headers: expect.objectContaining({ 'X-Workspace-Id': 'ws-custom' }),
					}),
				)
			})
		})

		describe('get_workspace_skill handler', () => {
			it('GETs /api/workspaces/:id/skills/:name with the full skill', async () => {
				mockFetchSuccess({ id: 's1', name: 'bug-fix', content: '# Bug fix skill' })

				const handler = getHandler('get_workspace_skill')
				const result = (await handler({ name: 'bug-fix' })) as {
					content: Array<{ text: string }>
				}

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/bug-fix',
					expect.objectContaining({ method: 'GET' }),
				)
				const parsed = JSON.parse(result.content[0].text)
				expect(parsed.content).toBe('# Bug fix skill')
			})

			it('url-encodes the name segment', async () => {
				mockFetchSuccess({})
				const handler = getHandler('get_workspace_skill')
				// skillNameSchema rejects non-[a-z0-9-] names, so this is defense-in-depth
				// for a name with characters that still need escaping as a path segment.
				await handler({ name: 'a-b' })
				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/a-b',
					expect.anything(),
				)
			})
		})

		describe('create_workspace_skill handler', () => {
			it('POSTs /api/workspaces/:id/skills with name and content', async () => {
				mockFetchSuccess({ id: 's1', name: 'bug-fix', content: '# body' })

				const handler = getHandler('create_workspace_skill')
				const result = (await handler({ name: 'bug-fix', content: '# body' })) as {
					content: Array<{ text: string }>
				}

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills',
					expect.objectContaining({ method: 'POST' }),
				)
				const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
				expect(body).toEqual({ name: 'bug-fix', content: '# body' })
				expect(JSON.parse(result.content[0].text).name).toBe('bug-fix')
			})

			it('uses workspace_id from args when provided', async () => {
				mockFetchSuccess({})
				const handler = getHandler('create_workspace_skill')
				await handler({ workspace_id: 'ws-custom', name: 'my-skill', content: '# x' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-custom/skills',
					expect.objectContaining({ method: 'POST' }),
				)
			})
		})

		describe('update_workspace_skill handler', () => {
			it('PUTs /api/workspaces/:id/skills/:name with content only', async () => {
				mockFetchSuccess({ id: 's1', name: 'bug-fix', content: '# updated' })

				const handler = getHandler('update_workspace_skill')
				await handler({ name: 'bug-fix', content: '# updated' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/bug-fix',
					expect.objectContaining({ method: 'PUT' }),
				)
				const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
				expect(body).toEqual({ content: '# updated' })
			})
		})

		describe('delete_workspace_skill handler', () => {
			it('DELETEs /api/workspaces/:id/skills/:name', async () => {
				mockFetchSuccess({ deleted: true })

				const handler = getHandler('delete_workspace_skill')
				const result = (await handler({ name: 'bug-fix' })) as {
					content: Array<{ text: string }>
				}

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/ws-default-123/skills/bug-fix',
					expect.objectContaining({ method: 'DELETE' }),
				)
				expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true })
			})
		})

		it('throws when no workspace is configured and none provided', async () => {
			vi.clearAllMocks()
			const handlersNoWs = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				handlersNoWs.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer({ ...config, defaultWorkspaceId: '' })

			const handler = handlersNoWs.get('list_workspace_skills')
			if (!handler) throw new Error('handler missing')
			await expect(handler({})).rejects.toThrow(/No workspace specified/)
		})
	})

	describe('set_llm_api_key handler', () => {
		// PATCHes the workspace with a single-provider delta. The server deep-
		// merges llm_keys, so the MCP tool is a straight pass-through — no
		// read-modify-write. One fetch call per invocation.
		it('PATCHes only the target provider and returns masked last4', async () => {
			mockFetchSuccess({ id: 'ws-default-123', name: 'My Workspace', settings: {} })

			const handler = getHandler('set_llm_api_key')
			const result = (await handler({
				provider: 'anthropic',
				api_key: 'sk-ant-new-key-WXYZ',
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe('http://localhost:3000/api/workspaces/ws-default-123')
			expect(patchCall[1]?.method).toBe('PATCH')
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ anthropic: 'sk-ant-new-key-WXYZ' })

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({ success: true, provider: 'anthropic', last4: 'WXYZ' })
			expect(result.content[0].text).not.toContain('sk-ant-new-key-WXYZ')
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({ id: 'ws-custom', name: 'Other', settings: {} })

			const handler = getHandler('set_llm_api_key')
			await handler({ workspace_id: 'ws-custom', provider: 'openai', api_key: 'sk-foo' })

			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe('http://localhost:3000/api/workspaces/ws-custom')
		})

		it('back-to-back sets for both providers each send only their own delta', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-default-123', name: 'My', settings: {} }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-default-123', name: 'My', settings: {} }),
				} as Response)

			const handler = getHandler('set_llm_api_key')
			await handler({ provider: 'anthropic', api_key: 'sk-ant-ABCD' })
			await handler({ provider: 'openai', api_key: 'sk-openai-EFGH' })

			const [firstCall, secondCall] = vi.mocked(fetch).mock.calls
			expect(JSON.parse(firstCall[1]?.body as string).settings.llm_keys).toEqual({
				anthropic: 'sk-ant-ABCD',
			})
			expect(JSON.parse(secondCall[1]?.body as string).settings.llm_keys).toEqual({
				openai: 'sk-openai-EFGH',
			})
		})
	})

	describe('get_llm_api_keys handler', () => {
		it('reads settings.llm_keys and returns masked status per provider', async () => {
			mockFetchSuccess([
				{
					id: 'ws-default-123',
					name: 'My Workspace',
					settings: {
						llm_keys: { anthropic: 'sk-ant-abcdEFGH', openai: 'sk-opq-MNOP' },
					},
				},
			])

			const handler = getHandler('get_llm_api_keys')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({
				anthropic: { set: true, last4: 'EFGH' },
				openai: { set: true, last4: 'MNOP' },
			})
			expect(result.content[0].text).not.toContain('sk-ant-abcdEFGH')
		})

		it('returns { set: false } for missing providers', async () => {
			mockFetchSuccess([{ id: 'ws-default-123', name: 'My Workspace', settings: { llm_keys: {} } }])

			const handler = getHandler('get_llm_api_keys')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({
				anthropic: { set: false },
				openai: { set: false },
			})
		})
	})

	describe('delete_llm_api_key handler', () => {
		it('PATCHes the target provider to null so the server strips it', async () => {
			mockFetchSuccess({ id: 'ws-default-123', name: 'My Workspace', settings: {} })

			const handler = getHandler('delete_llm_api_key')
			const result = (await handler({ provider: 'anthropic' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe('http://localhost:3000/api/workspaces/ws-default-123')
			expect(patchCall[1]?.method).toBe('PATCH')
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ anthropic: null })
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual({ success: true, provider: 'anthropic' })
		})

		it('delete on an unset provider still sends one PATCH and reports success', async () => {
			// Server-side deep-merge treats null as "delete if present"; deleting
			// a missing provider is a no-op there, so the MCP tool still returns
			// success without needing to inspect current state.
			mockFetchSuccess({ id: 'ws-default-123', name: 'My Workspace', settings: {} })

			const handler = getHandler('delete_llm_api_key')
			const result = (await handler({ provider: 'openai' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ openai: null })
			expect(JSON.parse(result.content[0].text)).toEqual({ success: true, provider: 'openai' })
		})
	})

	describe('import_claude_subscription handler', () => {
		it('POSTs /api/claude-oauth/import with camelCased token fields', async () => {
			const mockResult = { success: true, subscription_type: 'max', expires_at: 1 }
			mockFetchSuccess(mockResult)

			const handler = getHandler('import_claude_subscription')
			await handler({
				access_token: 'at',
				refresh_token: 'rt',
				expires_at: 1_700_000_000_000,
				subscription_type: 'max',
				scopes: ['read'],
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/claude-oauth/import',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer ank_testkey123',
						'X-Workspace-Id': 'ws-default-123',
					}),
				}),
			)
			const fetchCall = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse(fetchCall[1]?.body as string)
			expect(body).toEqual({
				accessToken: 'at',
				refreshToken: 'rt',
				expiresAt: 1_700_000_000_000,
				subscriptionType: 'max',
				scopes: ['read'],
			})
		})
	})

	describe('get_claude_subscription_status handler', () => {
		it('GETs /api/claude-oauth/status and returns payload', async () => {
			const mockResult = {
				connected: true,
				valid: true,
				subscription_type: 'max',
				expires_at: 1,
			}
			mockFetchSuccess(mockResult)

			const handler = getHandler('get_claude_subscription_status')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/claude-oauth/status',
				expect.objectContaining({ method: 'GET' }),
			)
			expect(JSON.parse(result.content[0].text)).toEqual(mockResult)
		})
	})

	describe('disconnect_claude_subscription handler', () => {
		it('DELETEs /api/claude-oauth', async () => {
			mockFetchSuccess({ success: true })

			const handler = getHandler('disconnect_claude_subscription')
			await handler({})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/claude-oauth',
				expect.objectContaining({ method: 'DELETE' }),
			)
		})
	})

	describe('get_comments handler', () => {
		const objectId = '550e8400-e29b-41d4-a716-446655440000'

		it('GETs /api/events/history with comment filters pinned', async () => {
			mockFetchSuccess([])

			const handler = getHandler('get_comments')
			await handler({ entity_id: objectId, limit: 25, offset: 5 })

			const call = vi.mocked(fetch).mock.calls[0]
			const url = call[0] as string
			expect(url).toContain('/api/events/history?')
			expect(url).toContain('entity_type=object')
			expect(url).toContain(`entity_id=${objectId}`)
			expect(url).toContain('action=commented')
			expect(url).toContain('limit=25')
			expect(url).toContain('offset=5')
			expect((call[1] as RequestInit).method).toBe('GET')
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess([])

			const handler = getHandler('get_comments')
			await handler({ entity_id: objectId, workspace_id: 'ws-custom', limit: 50, offset: 0 })

			expect(fetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({ 'X-Workspace-Id': 'ws-custom' }),
				}),
			)
		})
	})

	describe('create_comment handler', () => {
		const objectId = '550e8400-e29b-41d4-a716-446655440000'
		const agentId = '660e8400-e29b-41d4-a716-446655440000'

		it('POSTs to /api/events with body', async () => {
			const mockResult = { id: 1, action: 'commented' }
			mockFetchSuccess(mockResult)

			const handler = getHandler('create_comment')
			const result = (await handler({
				entity_id: objectId,
				content: 'hi from mcp',
				mentions: [agentId],
				parent_event_id: 42,
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/events',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer ank_testkey123',
						'X-Workspace-Id': 'ws-default-123',
					}),
				}),
			)

			const call = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse((call[1] as RequestInit).body as string)
			expect(body).toEqual({
				entity_id: objectId,
				content: 'hi from mcp',
				mentions: [agentId],
				parent_event_id: 42,
			})

			expect(JSON.parse(result.content[0].text)).toEqual(mockResult)
		})

		it('strips workspace_id from the POST body', async () => {
			mockFetchSuccess({})

			const handler = getHandler('create_comment')
			await handler({
				workspace_id: 'ws-custom',
				entity_id: objectId,
				content: 'hello',
			})

			const call = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse((call[1] as RequestInit).body as string)
			expect(body).not.toHaveProperty('workspace_id')
			expect(body.entity_id).toBe(objectId)
			expect(body.content).toBe('hello')

			expect(call[1]).toMatchObject({
				headers: expect.objectContaining({ 'X-Workspace-Id': 'ws-custom' }),
			})
		})
	})

	describe('workspace schema handlers', () => {
		// Each tool runs read-modify-write on settings.field_definitions plus a
		// post-PATCH verify re-read. So every successful call mocks three fetches:
		//   1. GET  /api/workspaces        — read current state
		//   2. PATCH /api/workspaces/:id   — write merged state
		//   3. GET  /api/workspaces        — verify the change landed
		type FieldDef = {
			name: string
			type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
			required?: boolean
			values?: string[]
		}
		const wsId = 'ws-default-123'
		const buildWorkspace = (fields: Record<string, FieldDef[]>) => ({
			id: wsId,
			name: 'My Workspace',
			settings: { field_definitions: fields },
		})

		function mockRmwSequence(
			initial: Record<string, FieldDef[]>,
			after: Record<string, FieldDef[]>,
		) {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([buildWorkspace(initial)]),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(buildWorkspace(after)),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([buildWorkspace(after)]),
				} as Response)
		}

		function lastPatchBody(): { settings: { field_definitions: Record<string, FieldDef[]> } } {
			const calls = vi.mocked(fetch).mock.calls
			const patch = [...calls].reverse().find((c) => (c[1] as RequestInit)?.method === 'PATCH')
			if (!patch) throw new Error('no PATCH call')
			return JSON.parse((patch[1] as RequestInit).body as string)
		}

		describe('create_workspace_field', () => {
			it('appends a new text field and PATCHes the merged field_definitions', async () => {
				mockRmwSequence(
					{ task: [{ name: 'priority', type: 'text' }] },
					{
						task: [
							{ name: 'priority', type: 'text' },
							{ name: 'tag', type: 'text', required: true },
						],
					},
				)

				const handler = getHandler('create_workspace_field')
				const result = (await handler({
					type: 'task',
					name: 'tag',
					field_type: 'text',
					required: true,
				})) as { content: Array<{ text: string }> }

				const body = lastPatchBody()
				expect(body.settings.field_definitions.task).toEqual([
					{ name: 'priority', type: 'text' },
					{ name: 'tag', type: 'text', required: true },
				])
				const parsed = JSON.parse(result.content[0].text)
				expect(parsed.field).toEqual({ name: 'tag', type: 'text', required: true })
			})

			it('sends an Idempotency-Key header on the PATCH', async () => {
				mockRmwSequence({ task: [] }, { task: [{ name: 'tag', type: 'text' }] })
				const handler = getHandler('create_workspace_field')
				await handler({ type: 'task', name: 'tag', field_type: 'text' })

				const calls = vi.mocked(fetch).mock.calls
				const patch = calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH')
				if (!patch) throw new Error('no PATCH call')
				const headers = (patch[1] as RequestInit).headers as Record<string, string>
				expect(headers['Idempotency-Key']).toMatch(/^mcp-schema-ws-default-123-/)
			})

			it('throws when enum is created without values', async () => {
				const fetchSpy = vi.spyOn(globalThis, 'fetch')
				const handler = getHandler('create_workspace_field')
				await expect(
					handler({ type: 'task', name: 'priority', field_type: 'enum' }),
				).rejects.toThrow(/Enum fields require at least one value/)
				expect(fetchSpy).not.toHaveBeenCalled()
			})

			it('throws when the field name already exists on the type', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([buildWorkspace({ task: [{ name: 'tag', type: 'text' }] })]),
				} as Response)

				const handler = getHandler('create_workspace_field')
				await expect(handler({ type: 'task', name: 'tag', field_type: 'text' })).rejects.toThrow(
					/already exists on type "task"/,
				)
			})

			it('retries when post-PATCH verify shows the change was clobbered', async () => {
				const desired: FieldDef[] = [{ name: 'tag', type: 'text' }]
				vi.spyOn(globalThis, 'fetch')
					// Attempt 1: read empty, PATCH, verify shows it was clobbered (still empty)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: [] })]),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve(buildWorkspace({ task: [] })),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: [] })]),
					} as Response)
					// Attempt 2: read, PATCH, verify succeeds
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: [] })]),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve(buildWorkspace({ task: desired })),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: desired })]),
					} as Response)

				const handler = getHandler('create_workspace_field')
				const result = (await handler({
					type: 'task',
					name: 'tag',
					field_type: 'text',
				})) as { content: Array<{ text: string }> }

				expect(JSON.parse(result.content[0].text).field).toEqual({ name: 'tag', type: 'text' })
				const patches = vi
					.mocked(fetch)
					.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH')
				expect(patches.length).toBe(2)
			})

			it('gives up after 3 attempts when verify never agrees', async () => {
				const stuck = buildWorkspace({ task: [] })
				vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
					if ((init as RequestInit | undefined)?.method === 'PATCH') {
						return Promise.resolve({ ok: true, json: () => Promise.resolve(stuck) } as Response)
					}
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve([stuck]),
					} as Response)
				})

				const handler = getHandler('create_workspace_field')
				await expect(handler({ type: 'task', name: 'tag', field_type: 'text' })).rejects.toThrow(
					/Concurrent edit detected/,
				)
			})
		})

		describe('update_workspace_field', () => {
			it('renames a field and rejects collisions with another field on the same type', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve([
							buildWorkspace({
								task: [
									{ name: 'tag', type: 'text' },
									{ name: 'label', type: 'text' },
								],
							}),
						]),
				} as Response)

				const handler = getHandler('update_workspace_field')
				await expect(handler({ type: 'task', name: 'tag', new_name: 'label' })).rejects.toThrow(
					/already exists on type "task"/,
				)
			})

			it('switches type from enum to text and drops stale values on PATCH', async () => {
				const before: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low', 'high'] }],
				}
				const after: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'text' }],
				}
				mockRmwSequence(before, after)

				const handler = getHandler('update_workspace_field')
				await handler({ type: 'task', name: 'priority', field_type: 'text' })

				const body = lastPatchBody()
				expect(body.settings.field_definitions.task).toEqual([{ name: 'priority', type: 'text' }])
			})

			it('throws when switching to enum with no available values', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([buildWorkspace({ task: [{ name: 'tag', type: 'text' }] })]),
				} as Response)

				const handler = getHandler('update_workspace_field')
				await expect(handler({ type: 'task', name: 'tag', field_type: 'enum' })).rejects.toThrow(
					/Enum fields require at least one value/,
				)
			})
		})

		describe('delete_workspace_field', () => {
			it('removes the named field from the type', async () => {
				const before: Record<string, FieldDef[]> = {
					task: [
						{ name: 'tag', type: 'text' },
						{ name: 'priority', type: 'enum', values: ['low'] },
					],
				}
				const after: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low'] }],
				}
				mockRmwSequence(before, after)

				const handler = getHandler('delete_workspace_field')
				const result = (await handler({ type: 'task', name: 'tag' })) as {
					content: Array<{ text: string }>
				}

				expect(lastPatchBody().settings.field_definitions.task).toEqual(after.task)
				const parsed = JSON.parse(result.content[0].text)
				expect(parsed).toMatchObject({ deleted: 'tag', success: true })
			})
		})

		describe('add_workspace_enum_value', () => {
			it('appends the value to an enum field', async () => {
				const before: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low'] }],
				}
				const after: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low', 'high'] }],
				}
				mockRmwSequence(before, after)

				const handler = getHandler('add_workspace_enum_value')
				await handler({ type: 'task', name: 'priority', value: 'high' })

				expect(lastPatchBody().settings.field_definitions.task[0]?.values).toEqual(['low', 'high'])
			})

			it('throws when the field is not an enum', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([buildWorkspace({ task: [{ name: 'tag', type: 'text' }] })]),
				} as Response)

				const handler = getHandler('add_workspace_enum_value')
				await expect(handler({ type: 'task', name: 'tag', value: 'x' })).rejects.toThrow(
					/not "enum"/,
				)
			})

			it('throws when the field does not exist', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve([buildWorkspace({ task: [] })]),
				} as Response)

				const handler = getHandler('add_workspace_enum_value')
				await expect(handler({ type: 'task', name: 'missing', value: 'x' })).rejects.toThrow(
					/not found on type "task"/,
				)
			})
		})

		describe('remove_workspace_enum_value', () => {
			it('removes the value from the enum field', async () => {
				const before: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low', 'high'] }],
				}
				const after: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low'] }],
				}
				mockRmwSequence(before, after)

				const handler = getHandler('remove_workspace_enum_value')
				await handler({ type: 'task', name: 'priority', value: 'high' })

				expect(lastPatchBody().settings.field_definitions.task[0]?.values).toEqual(['low'])
			})

			it('is a no-op when the value is already absent (still PATCHes once)', async () => {
				const same: Record<string, FieldDef[]> = {
					task: [{ name: 'priority', type: 'enum', values: ['low'] }],
				}
				mockRmwSequence(same, same)

				const handler = getHandler('remove_workspace_enum_value')
				await handler({ type: 'task', name: 'priority', value: 'high' })

				expect(lastPatchBody().settings.field_definitions.task[0]?.values).toEqual(['low'])
			})

			it('throws when the enum field has no values list', async () => {
				vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve([buildWorkspace({ task: [{ name: 'priority', type: 'enum' }] })]),
				} as Response)

				const handler = getHandler('remove_workspace_enum_value')
				await expect(handler({ type: 'task', name: 'priority', value: 'low' })).rejects.toThrow(
					/has no values list/,
				)
			})
		})

		describe('cross-type concurrency', () => {
			it('detects a concurrent edit on a different type and retries', async () => {
				// Attempt 1: read sees only `task`. Our PATCH would replace
				// field_definitions wholesale and clobber a concurrent edit on `note`.
				// Verify reads back the post-PATCH workspace and finds `note: [n]` —
				// proof another writer landed between our GET and PATCH — so we retry.
				// Attempt 2: read includes `note`, PATCH preserves it, verify agrees.
				const taskAfter: FieldDef[] = [{ name: 'tag', type: 'text' }]
				const noteFromOther: FieldDef[] = [{ name: 'n', type: 'text' }]
				vi.spyOn(globalThis, 'fetch')
					// Attempt 1
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: [] })]),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve(buildWorkspace({ task: taskAfter })),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: taskAfter, note: noteFromOther })]),
					} as Response)
					// Attempt 2 — read now includes note, so our PATCH preserves it
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: [], note: noteFromOther })]),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve(buildWorkspace({ task: taskAfter, note: noteFromOther })),
					} as Response)
					.mockResolvedValueOnce({
						ok: true,
						json: () => Promise.resolve([buildWorkspace({ task: taskAfter, note: noteFromOther })]),
					} as Response)

				const handler = getHandler('create_workspace_field')
				await handler({ type: 'task', name: 'tag', field_type: 'text' })

				const patches = vi
					.mocked(fetch)
					.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'PATCH')
				expect(patches.length).toBe(2)
				const finalBody = JSON.parse((patches[1]?.[1] as RequestInit).body as string) as {
					settings: { field_definitions: Record<string, FieldDef[]> }
				}
				expect(finalBody.settings.field_definitions.note).toEqual(noteFromOther)
				expect(finalBody.settings.field_definitions.task).toEqual(taskAfter)
			})
		})
	})

	describe('Hero Card structuredContent + per-response swap', () => {
		it('populates structuredContent.heroCard and swaps to hero-card resource when the response is a single bet', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/bet-9/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'bet-9',
									type: 'bet',
									title: 'Test bet',
									status: 'active',
									driver: 'actor-1',
									createdAt: new Date().toISOString(),
								},
							}),
					} as Response
				}
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						json: () => Promise.resolve([{ id: 'actor-1', name: 'Sebastian' }]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['bet-9'] })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: { heroCard: { kind: string; object?: { driver?: unknown } } }
			}

			expect(result.structuredContent.heroCard.kind).toBe('single')
			expect(result.structuredContent.heroCard.object?.driver).toEqual({
				id: 'actor-1',
				name: 'Sebastian',
				type: null,
			})
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
		})

		it('routes a single task result through the hero-card resource with a task-shaped context line', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/task-9/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'task-9',
									type: 'task',
									title: 'Test task',
									status: 'in_progress',
									driver: 'actor-2',
								},
							}),
					} as Response
				}
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						json: () => Promise.resolve([{ id: 'actor-2', name: 'Magnus' }]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['task-9'] })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: { kind: string; object?: { contextLine?: string; driver?: unknown } }
				}
			}

			expect(result.structuredContent.heroCard.kind).toBe('single')
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.object?.contextLine).toBe(
				'in_progress · driver Magnus',
			)
		})

		it('routes a single insight result through the hero-card resource with an anchor + cluster context line', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/insight-7/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'insight-7',
									type: 'insight',
									title: 'Pricing pain',
									status: 'clustered',
									driver: null,
									metadata: { anchors: ['#3', '#6'], cluster_size: 4 },
								},
							}),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['insight-7'] })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: { kind: string; object?: { contextLine?: string } }
				}
			}

			expect(result.structuredContent.heroCard.kind).toBe('single')
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.object?.contextLine).toBe(
				'clustered · anchor #3+#6 · 4 sources',
			)
		})

		it('keeps the objects resource for single results of an unknown type (default fallback)', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/customer-1/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'customer-1',
									type: 'customer',
									title: 'Acme Inc.',
									status: 'engaged',
									driver: null,
								},
							}),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['customer-1'] })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: { heroCard: { kind: string } }
			}

			expect(result.structuredContent.heroCard.kind).toBe('single')
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/objects')
		})

		it('resolves hero-card driver names via a batched ?ids= lookup, not the full actor list', async () => {
			const calls: string[] = []
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				calls.push(urlStr)
				if (urlStr.includes('/api/objects/search')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{ id: 'bet-1', type: 'bet', title: 'Bet One', status: 'active', driver: 'actor-1' },
								{ id: 'bet-2', type: 'bet', title: 'Bet Two', status: 'active', driver: 'actor-2' },
								{
									id: 'bet-3',
									type: 'bet',
									title: 'Bet Three',
									status: 'active',
									driver: 'actor-1',
								},
							]),
					} as Response
				}
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{ id: 'actor-1', name: 'Alice' },
								{ id: 'actor-2', name: 'Bob' },
							]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})

			const handler = getHandler('search_objects')
			const result = (await handler({ q: 'bet' })) as {
				structuredContent: {
					heroCard: {
						kind: string
						objects?: Array<{ driver?: { id: string; name: string | null; type: string | null } }>
					}
				}
			}

			const actorCall = calls.find((u) => u.includes('/api/actors'))
			expect(actorCall).toBeDefined()
			// Single batched request, not the unbounded full-workspace fetch.
			expect(calls.filter((u) => u.includes('/api/actors'))).toHaveLength(1)
			expect(actorCall).toContain('?ids=')
			// Driver IDs are deduped — actor-1 appears twice in the result rows.
			const idsParam = new URL(actorCall as string).searchParams.get('ids') ?? ''
			const ids = idsParam.split(',').filter(Boolean)
			expect(ids.sort()).toEqual(['actor-1', 'actor-2'])

			expect(result.structuredContent.heroCard.kind).toBe('list')
			const drivers = result.structuredContent.heroCard.objects?.map((o) => o.driver)
			expect(drivers).toEqual([
				{ id: 'actor-1', name: 'Alice', type: null },
				{ id: 'actor-2', name: 'Bob', type: null },
				{ id: 'actor-1', name: 'Alice', type: null },
			])
		})

		it('falls back to { id, name: null } when the batched lookup misses an actor', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/search')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{ id: 'bet-1', type: 'bet', title: 'Bet One', status: 'active', driver: 'actor-1' },
								{ id: 'bet-2', type: 'bet', title: 'Bet Two', status: 'active', driver: 'actor-2' },
							]),
					} as Response
				}
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						json: () => Promise.resolve([{ id: 'actor-1', name: 'Alice' }]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})

			const handler = getHandler('search_objects')
			const result = (await handler({ q: 'bet' })) as {
				structuredContent: {
					heroCard: {
						objects?: Array<{ driver?: { id: string; name: string | null; type: string | null } }>
					}
				}
			}
			const drivers = result.structuredContent.heroCard.objects?.map((o) => o.driver)
			expect(drivers).toEqual([
				{ id: 'actor-1', name: 'Alice', type: null },
				{ id: 'actor-2', name: null, type: null },
			])
		})

		it('emits an empty heroCard for list_objects with no rows', async () => {
			mockFetchSuccess([])
			const handler = getHandler('list_objects')
			const result = (await handler({ type: 'bet', limit: 50, offset: 0 })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: { heroCard: { kind: string; tool: string } }
			}
			expect(result.structuredContent.heroCard.kind).toBe('empty')
			expect(result.structuredContent.heroCard.tool).toBe('list_objects')
			// Collection tools always route through the Hero Card bundle so the
			// 0/1/N branches render through a single widget; T6 broadened the
			// predicate from single-bet to every list/search response.
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
		})

		it('emits a list heroCard and uses the hero-card resource for multi-row list_objects', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects?')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{ id: 'bet-1', type: 'bet', title: 'Bet 1', status: 'active' },
								{ id: 'bet-2', type: 'bet', title: 'Bet 2', status: 'shaping' },
							]),
					} as Response
				}
				if (urlStr.endsWith('/api/actors')) {
					return { ok: true, json: () => Promise.resolve([]) } as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})
			const handler = getHandler('list_objects')
			const result = (await handler({ type: 'bet', limit: 50, offset: 0 })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: { kind: string; tool: string; totalCount?: number }
				}
			}
			expect(result.structuredContent.heroCard.kind).toBe('list')
			expect(result.structuredContent.heroCard.totalCount).toBe(2)
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
		})

		it('caps the list_objects heroCard at 25 rows while exposing all returned objects', async () => {
			const rows = Array.from({ length: 100 }, (_, i) => ({
				id: `bet-${i + 1}`,
				type: 'bet',
				title: `Bet ${i + 1}`,
				status: 'active',
			}))
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects?')) {
					return { ok: true, json: () => Promise.resolve(rows) } as Response
				}
				if (urlStr.endsWith('/api/actors')) {
					return { ok: true, json: () => Promise.resolve([]) } as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})

			const handler = getHandler('list_objects')
			const result = (await handler({ type: 'bet', limit: 100, offset: 0 })) as {
				structuredContent: {
					heroCard: {
						objects?: unknown[]
						totalCount?: number
						page?: { limit: number; hasMore: boolean }
					}
					objects: unknown[]
				}
			}

			expect(result.structuredContent.heroCard.objects).toHaveLength(25)
			expect(result.structuredContent.heroCard.totalCount).toBe(100)
			expect(result.structuredContent.heroCard.page).toMatchObject({
				limit: 25,
				hasMore: true,
			})
			expect(result.structuredContent.objects).toHaveLength(100)
		})

		it('emits a list heroCard for list_actors with type=actor rows', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						headers: new Headers({ 'X-Total-Count': '2' }),
						json: () =>
							Promise.resolve([
								{ id: 'a-1', type: 'human', name: 'Sebastian', email: 's@x.test' },
								{ id: 'a-2', type: 'agent', name: 'Workspace Coach', role: 'admin' },
							]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})
			const handler = getHandler('list_actors')
			const result = (await handler({ workspace_id: 'ws-1' })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: {
						kind: string
						tool: string
						totalCount?: number
						objects?: Array<{ type: string; title: string | null; contextLine: string }>
					}
				}
			}
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.kind).toBe('list')
			expect(result.structuredContent.heroCard.tool).toBe('list_actors')
			expect(result.structuredContent.heroCard.totalCount).toBe(2)
			expect(result.structuredContent.heroCard.objects?.[0]?.type).toBe('actor')
			expect(result.structuredContent.heroCard.objects?.[0]?.title).toBe('Sebastian')
		})

		it('emits a single heroCard for get_actor', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/actors/a-1')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								id: 'a-1',
								type: 'agent',
								name: 'Designer',
								email: null,
								role: 'running',
							}),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})
			const handler = getHandler('get_actor')
			const result = (await handler({ id: 'a-1', workspace_id: 'ws-1' })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: {
						kind: string
						tool: string
						object?: { type: string; title: string | null; status: string | null }
					}
				}
			}
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.kind).toBe('single')
			expect(result.structuredContent.heroCard.tool).toBe('get_actor')
			expect(result.structuredContent.heroCard.object).toMatchObject({
				type: 'actor',
				title: 'Designer',
				status: 'running',
			})
		})

		it('emits a list heroCard for list_workspaces with type=workspace rows', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/workspaces')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve([
								{ id: 'ws-1', name: 'Maskin', role: 'owner' },
								{ id: 'ws-2', name: 'Reflect Studio', role: 'member' },
							]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})
			const handler = getHandler('list_workspaces')
			const result = (await handler({})) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: {
						kind: string
						tool: string
						totalCount?: number
						objects?: Array<{ type: string; title: string | null; status: string | null }>
					}
				}
			}
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.kind).toBe('list')
			expect(result.structuredContent.heroCard.tool).toBe('list_workspaces')
			expect(result.structuredContent.heroCard.totalCount).toBe(2)
			expect(result.structuredContent.heroCard.objects?.[0]).toMatchObject({
				type: 'workspace',
				title: 'Maskin',
				status: 'owner',
			})
		})

		it('passes limit/offset to /api/actors and uses X-Total-Count for the +N more footer', async () => {
			const calls: string[] = []
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				calls.push(urlStr)
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						headers: new Headers({ 'X-Total-Count': '1234' }),
						json: () =>
							Promise.resolve([{ id: 'a-1', type: 'human', name: 'Alice', email: 'a@x.test' }]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})
			const handler = getHandler('list_actors')
			const result = (await handler({ workspace_id: 'ws-1', limit: 1, offset: 0 })) as {
				structuredContent: {
					heroCard: { kind: string; totalCount?: number }
				}
			}
			expect(calls.some((u) => u.includes('limit=1') && u.includes('offset=0'))).toBe(true)
			expect(result.structuredContent.heroCard.kind).toBe('list')
			expect(result.structuredContent.heroCard.totalCount).toBe(1234)
		})

		it('collapses list_actors to single heroCard when total is exactly 1', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
				return {
					ok: true,
					headers: new Headers({ 'X-Total-Count': '1' }),
					json: () =>
						Promise.resolve([{ id: 'a-1', type: 'human', name: 'Solo', email: 's@x.test' }]),
				} as Response
			})
			const handler = getHandler('list_actors')
			const result = (await handler({ workspace_id: 'ws-1' })) as {
				structuredContent: { heroCard: { kind: string } }
			}
			expect(result.structuredContent.heroCard.kind).toBe('single')
		})

		it('emits a list heroCard for list_triggers with type=trigger rows + resolved target actor', async () => {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/triggers')) {
					return {
						ok: true,
						headers: new Headers({ 'X-Total-Count': '2' }),
						json: () =>
							Promise.resolve([
								{
									id: 't-1',
									type: 'cron',
									name: 'Daily sweep',
									enabled: true,
									targetActorId: 'actor-1',
								},
								{
									id: 't-2',
									type: 'event',
									name: 'On comment',
									enabled: false,
									targetActorId: null,
								},
							]),
					} as Response
				}
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						json: () => Promise.resolve([{ id: 'actor-1', name: 'Workspace Coach' }]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})
			const handler = getHandler('list_triggers')
			const result = (await handler({ workspace_id: 'ws-1' })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: {
						kind: string
						tool: string
						totalCount?: number
						objects?: Array<{
							type: string
							status: string | null
							driver: { name: string | null } | null
						}>
					}
				}
			}
			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.kind).toBe('list')
			expect(result.structuredContent.heroCard.tool).toBe('list_triggers')
			expect(result.structuredContent.heroCard.totalCount).toBe(2)
			expect(result.structuredContent.heroCard.objects?.[0]?.type).toBe('trigger')
			expect(result.structuredContent.heroCard.objects?.[0]?.status).toBe('enabled')
			expect(result.structuredContent.heroCard.objects?.[0]?.driver?.name).toBe('Workspace Coach')
			expect(result.structuredContent.heroCard.objects?.[1]?.status).toBe('disabled')
		})

		it('passes limit/offset to /api/triggers and uses X-Total-Count for the +N more footer', async () => {
			const calls: string[] = []
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				calls.push(urlStr)
				if (urlStr.includes('/api/triggers')) {
					return {
						ok: true,
						headers: new Headers({ 'X-Total-Count': '987' }),
						json: () =>
							Promise.resolve([
								{
									id: 't-1',
									type: 'cron',
									name: 'Daily sweep',
									enabled: true,
									targetActorId: null,
								},
							]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})
			const handler = getHandler('list_triggers')
			const result = (await handler({ workspace_id: 'ws-1', limit: 1, offset: 0 })) as {
				structuredContent: { heroCard: { kind: string; totalCount?: number } }
			}
			const triggersCalls = calls.filter((u) => u.includes('/api/triggers'))
			expect(triggersCalls.some((u) => u.includes('limit=1') && u.includes('offset=0'))).toBe(true)
			expect(result.structuredContent.heroCard.kind).toBe('list')
			expect(result.structuredContent.heroCard.totalCount).toBe(987)
		})

		it('swaps to the hero-card resource for a single organization (customer variant)', async () => {
			const updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString()
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/org-1/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'org-1',
									type: 'organization',
									title: 'Acme Co',
									status: 'qualifying',
									driver: 'actor-1',
									updatedAt,
								},
							}),
					} as Response
				}
				if (urlStr.includes('/api/actors')) {
					return {
						ok: true,
						json: () => Promise.resolve([{ id: 'actor-1', name: 'Sebastian' }]),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve({}) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['org-1'] })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: {
					heroCard: {
						kind: string
						object?: { type: string; contextLine: string; driver?: unknown }
					}
				}
			}

			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.kind).toBe('single')
			expect(result.structuredContent.heroCard.object?.type).toBe('organization')
			expect(result.structuredContent.heroCard.object?.contextLine).toBe(
				'last touch 3d ago · qualifying',
			)
		})

		it('swaps to the hero-card resource for a single person (customer variant)', async () => {
			const updatedAt = new Date(Date.now() - 1 * 86_400_000).toISOString()
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const urlStr = url as string
				if (urlStr.includes('/api/objects/person-1/graph')) {
					return {
						ok: true,
						json: () =>
							Promise.resolve({
								object: {
									id: 'person-1',
									type: 'person',
									title: 'Jane Doe',
									status: 'engaged',
									driver: null,
									updatedAt,
								},
							}),
					} as Response
				}
				return { ok: true, json: () => Promise.resolve([]) } as Response
			})

			const handler = getHandler('get_objects')
			const result = (await handler({ ids: ['person-1'] })) as {
				_meta: { ui?: { resourceUri?: string } }
				structuredContent: { heroCard: { kind: string; object?: { contextLine: string } } }
			}

			expect(result._meta.ui?.resourceUri).toBe('ui://maskin/hero-card')
			expect(result.structuredContent.heroCard.object?.contextLine).toBe(
				'last touch 1d ago · engaged',
			)
		})
	})

	describe('Hero Card schema-driven type annotations', () => {
		it('exposes hero_card annotations for organization and person in get_workspace_schema', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						{
							id: 'ws-1',
							name: 'Test Workspace',
							settings: {
								statuses: {
									organization: ['prospect', 'qualifying'],
									person: ['new', 'engaged'],
									bet: ['active'],
								},
							},
						},
					]),
			} as Response)
			const handler = getHandler('get_workspace_schema')
			const result = (await handler({ workspace_id: 'ws-1' })) as {
				content: Array<{ text: string }>
			}
			const parsed = JSON.parse(result.content[0].text) as {
				types: Record<string, { hero_card?: HeroCardTypeAnnotation }>
			}
			expect(parsed.types.organization?.hero_card?.hero_card_context).toBe('last touch + stage')
			expect(parsed.types.person?.hero_card?.hero_card_context).toBe('last touch + stage')
			// bet has no built-in annotation — schema-driven path is opt-in per type.
			expect(parsed.types.bet?.hero_card).toBeUndefined()
		})

		it('lets workspace settings override the built-in hero_card annotation', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve([
						{
							id: 'ws-2',
							name: 'Override',
							settings: {
								statuses: { organization: ['prospect'] },
								hero_card: {
									organization: {
										hero_card_context: 'custom strategy',
										primary_action: { label: 'View account', kind: 'open_object' },
									},
								},
							},
						},
					]),
			} as Response)
			const handler = getHandler('get_workspace_schema')
			const result = (await handler({ workspace_id: 'ws-2' })) as {
				content: Array<{ text: string }>
			}
			const parsed = JSON.parse(result.content[0].text) as {
				types: Record<string, { hero_card?: HeroCardTypeAnnotation }>
			}
			expect(parsed.types.organization?.hero_card?.hero_card_context).toBe('custom strategy')
			expect(parsed.types.organization?.hero_card?.primary_action?.label).toBe('View account')
		})

		it('renders a hypothetical new object type identically when given the same annotation', () => {
			// Proves the template is generic: an annotated type with no widget code,
			// no predicate edit, and no new constant entry renders the same Hero Card
			// surface as organization/person.
			const annotations: Record<string, HeroCardTypeAnnotation> = {
				...HERO_CARD_TYPE_DEFAULTS,
				account: HERO_CARD_TYPE_DEFAULTS.organization,
			}
			const updatedAt = new Date(Date.now() - 5 * 86_400_000).toISOString()
			const accountObj = {
				id: 'acct-1',
				type: 'account',
				title: 'Hypothetical Co',
				status: 'qualifying',
				updatedAt,
			}
			const orgObj = { ...accountObj, id: 'org-1', type: 'organization' }
			const accountHero = buildHeroCardObject(accountObj, null, Date.now(), annotations)
			const orgHero = buildHeroCardObject(orgObj, null, Date.now(), annotations)
			// Same context line, same owner shape — render path is type-agnostic.
			expect(accountHero.contextLine).toBe(orgHero.contextLine)
			expect(accountHero.contextLine).toBe('last touch 5d ago · qualifying')

			// Resource swap fires identically for the new type.
			const accountPayload = { kind: 'single' as const, tool: 't', object: accountHero }
			const orgPayload = { kind: 'single' as const, tool: 't', object: orgHero }
			expect(pickResourceUri(accountPayload, annotations)).toBe('ui://maskin/hero-card')
			expect(pickResourceUri(orgPayload, annotations)).toBe(
				pickResourceUri(accountPayload, annotations),
			)
		})

		it('falls back to type · status for an unannotated unknown type', () => {
			const obj = {
				id: 'x-1',
				type: 'something-new',
				title: 'X',
				status: 'open',
				createdAt: null,
			}
			expect(buildContextLine(obj, null)).toBe('something-new · open')
		})
	})

	describe('record_widget_event handler', () => {
		it('forwards click_through events to the telemetry sink', async () => {
			const events: unknown[] = []
			const localConfig = {
				...config,
				telemetrySink: (event: unknown) => events.push(event),
			}
			const localHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
			vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
				localHandlers.set(
					name as string,
					handler as (args: Record<string, unknown>) => Promise<unknown>,
				)
			})
			createMcpServer(localConfig)
			const handler = localHandlers.get('record_widget_event')
			if (!handler) throw new Error('record_widget_event not registered')
			await handler({
				widget_name: 'hero-card',
				event: 'click_through',
				tool_name: 'get_objects',
				card_kind: 'single',
				object_type: 'bet',
				object_id: 'bet-9',
			})
			const widgetEvents = events.filter(
				(e): e is { event_type: string; event: string } =>
					(e as { event_type?: unknown })?.event_type === 'widget_event',
			)
			expect(widgetEvents).toHaveLength(1)
			expect(widgetEvents[0]).toMatchObject({
				event_type: 'widget_event',
				event: 'click_through',
				widget_name: 'hero-card',
			})
		})
	})

	describe('update_actor handler', () => {
		const actorId = '550e8400-e29b-41d4-a716-446655440000'
		const skillId1 = '660e8400-e29b-41d4-a716-446655440001'
		const skillId2 = '660e8400-e29b-41d4-a716-446655440002'
		const mockActor = { id: actorId, name: 'Test Actor' }
		const mockSkill = { id: skillId1, name: 'My Skill' }

		it('returns actor directly when no skill ops are requested', async () => {
			mockFetchSuccess(mockActor)

			const handler = getHandler('update_actor')
			const result = (await handler({ id: actorId, name: 'Updated' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed).toEqual(mockActor)
		})

		it('attaches skills via one batched call and wraps response under actor key', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve(mockActor),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve([{ workspaceSkillId: skillId1, success: true, skill: mockSkill }]),
				} as Response)

			const handler = getHandler('update_actor')
			const result = (await handler({
				id: actorId,
				attach_skill_ids: [skillId1],
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenLastCalledWith(
				`http://localhost:3000/api/actors/${actorId}/workspace-skills/batch`,
				expect.objectContaining({ method: 'POST' }),
			)
			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.actor).toEqual(mockActor)
			expect(parsed.attached_skills).toHaveLength(1)
			expect(parsed.attached_skills[0]).toEqual(mockSkill)
			expect(parsed.detached_skills).toBeUndefined()
			expect(parsed.partial_failure).toBeUndefined()
		})

		it('detaches skills and includes detached_skills in response', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve(mockActor),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ deleted: true }),
				} as Response)

			const handler = getHandler('update_actor')
			const result = (await handler({
				id: actorId,
				detach_skill_ids: [skillId1],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.actor).toEqual(mockActor)
			expect(parsed.detached_skills).toHaveLength(1)
			expect(parsed.detached_skills[0]).toEqual({ skill_id: skillId1, deleted: true })
			expect(parsed.attached_skills).toBeUndefined()
		})

		it('handles attach and detach simultaneously', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve(mockActor),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve([{ workspaceSkillId: skillId1, success: true, skill: mockSkill }]),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ deleted: true }),
				} as Response)

			const handler = getHandler('update_actor')
			const result = (await handler({
				id: actorId,
				attach_skill_ids: [skillId1],
				detach_skill_ids: [skillId2],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.actor).toEqual(mockActor)
			expect(parsed.attached_skills).toHaveLength(1)
			expect(parsed.detached_skills).toHaveLength(1)
			expect(parsed.detached_skills[0]).toEqual({ skill_id: skillId2, deleted: true })
			expect(parsed.partial_failure).toBeUndefined()
		})

		it('sets partial_failure and records error string when a skill op fails', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve(mockActor),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () =>
						Promise.resolve([
							{ workspaceSkillId: skillId1, success: false, error: 'Workspace skill not found' },
						]),
				} as Response)

			const handler = getHandler('update_actor')
			const result = (await handler({
				id: actorId,
				attach_skill_ids: [skillId1],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.partial_failure).toBe(true)
			expect(parsed.attached_skills[0].skill_id).toBe(skillId1)
			expect(typeof parsed.attached_skills[0].error).toBe('string')
			expect(parsed.attached_skills[0].error).not.toBe('')
		})

		it('surfaces a non-Error rejection as a string rather than undefined', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve(mockActor),
				} as Response)
				.mockRejectedValueOnce('plain string rejection')

			const handler = getHandler('update_actor')
			const result = (await handler({
				id: actorId,
				attach_skill_ids: [skillId1],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text)
			expect(parsed.partial_failure).toBe(true)
			expect(parsed.attached_skills[0].error).toBe('plain string rejection')
		})

		it('throws when the same skill ID appears in both attach and detach arrays', async () => {
			const handler = getHandler('update_actor')
			await expect(
				handler({ id: actorId, attach_skill_ids: [skillId1], detach_skill_ids: [skillId1] }),
			).rejects.toThrow(/attach_skill_ids and detach_skill_ids/)
		})
	})
})

describe('url field injection', () => {
	const testUuid = '550e8400-e29b-41d4-a716-446655440000'

	let urlHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	const configWithUrl = {
		...config,
		webAppBaseUrl: 'https://maskin.example.com',
	}

	function getUrlHandler(name: string) {
		const handler = urlHandlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	beforeEach(() => {
		vi.mocked(McpServer).mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() }))
		vi.mocked(registerAppTool).mockReset()
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			urlHandlers.set(
				name as string,
				handler as (args: Record<string, unknown>) => Promise<unknown>,
			)
		})
		urlHandlers = new Map()
		createMcpServer(configWithUrl)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('omits url when webAppBaseUrl is not configured', async () => {
		const noUrlHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
		vi.mocked(registerAppTool).mockReset()
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			noUrlHandlers.set(
				name as string,
				handler as (args: Record<string, unknown>) => Promise<unknown>,
			)
		})
		createMcpServer(config)

		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			headers: new Headers(),
			json: () => Promise.resolve([{ id: 'obj-1', type: 'bet' }]),
		} as Response)

		const handler = noUrlHandlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')
		const result = (await handler({})) as { content: Array<{ text: string }> }
		const parsed = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>
		expect(parsed[0].url).toBeUndefined()
	})

	it('normalizes trailing slash in webAppBaseUrl', async () => {
		const trailingHandlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
		vi.mocked(registerAppTool).mockReset()
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			trailingHandlers.set(
				name as string,
				handler as (args: Record<string, unknown>) => Promise<unknown>,
			)
		})
		createMcpServer({ ...config, webAppBaseUrl: 'https://maskin.example.com/' })

		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			headers: new Headers(),
			json: () => Promise.resolve([{ id: 'obj-1', type: 'bet' }]),
		} as Response)

		const handler = trailingHandlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')
		const result = (await handler({})) as { content: Array<{ text: string }> }
		const parsed = JSON.parse(result.content[0].text) as Array<{ url: string }>
		expect(parsed[0].url).toBe('https://maskin.example.com/ws-default-123/objects/obj-1')
	})

	describe('object url', () => {
		it('list_objects — content and structuredContent.objects include url', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve([{ id: 'obj-1', type: 'bet' }]),
			} as Response)

			const handler = getUrlHandler('list_objects')
			const result = (await handler({})) as {
				content: Array<{ text: string }>
				structuredContent: { objects: Array<{ id: string; url?: string }> }
			}

			const parsed = JSON.parse(result.content[0].text) as Array<{ id: string; url: string }>
			expect(parsed[0].url).toBe('https://maskin.example.com/ws-default-123/objects/obj-1')
			expect(result.structuredContent.objects[0].url).toBe(
				'https://maskin.example.com/ws-default-123/objects/obj-1',
			)
		})

		it('get_objects — url added inside result.object in content and structuredContent', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () =>
					Promise.resolve({
						object: { id: 'obj-2', type: 'insight', title: 'Test' },
						relationships: [],
						connected_objects: [],
					}),
			} as Response)

			const handler = getUrlHandler('get_objects')
			const result = (await handler({ ids: ['obj-2'] })) as {
				content: Array<{ text: string }>
				structuredContent: { objects: Array<{ object: { id: string; url?: string } }> }
			}

			const text = JSON.parse(result.content[0].text) as Array<{
				success: boolean
				result: { object: { id: string; url: string } }
			}>
			expect(text[0].result.object.url).toBe(
				'https://maskin.example.com/ws-default-123/objects/obj-2',
			)
			expect(result.structuredContent.objects[0].object.url).toBe(
				'https://maskin.example.com/ws-default-123/objects/obj-2',
			)
		})

		it('create_objects — url added to each graph node', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () =>
					Promise.resolve({
						nodes: [{ $id: 'bet-1', id: 'obj-3', type: 'bet' }],
						edges: [],
					}),
			} as Response)

			const handler = getUrlHandler('create_objects')
			const result = (await handler({
				nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
				edges: [],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as {
				nodes: Array<{ id: string; url: string }>
			}
			expect(parsed.nodes[0].url).toBe('https://maskin.example.com/ws-default-123/objects/obj-3')
		})

		it('update_objects — url added to patched object result', async () => {
			const objectId = '11111111-1111-1111-1111-111111111111'
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: objectId, type: 'task', title: 'Updated' }),
			} as Response)

			const handler = getUrlHandler('update_objects')
			const result = (await handler({
				updates: [{ id: objectId, title: 'Updated' }],
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as Array<{
				type: string
				success: boolean
				result: { url: string }
			}>
			const objectEntry = parsed.find((e) => e.type === 'object' && e.success)
			expect(objectEntry?.result.url).toBe(
				`https://maskin.example.com/ws-default-123/objects/${objectId}`,
			)
		})
	})

	describe('actor url', () => {
		it('create_actor — url added to result', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: 'actor-1', type: 'agent', name: 'Bot' }),
			} as Response)

			const handler = getUrlHandler('create_actor')
			const result = (await handler({ type: 'agent', name: 'Bot' })) as {
				content: Array<{ text: string }>
			}

			const parsed = JSON.parse(result.content[0].text) as { id: string; url: string }
			expect(parsed.url).toBe('https://maskin.example.com/ws-default-123/agents/actor-1')
		})

		it('get_actor — url added to result', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: testUuid, type: 'human', name: 'Alice' }),
			} as Response)

			const handler = getUrlHandler('get_actor')
			const result = (await handler({ id: testUuid })) as {
				content: Array<{ text: string }>
			}

			const parsed = JSON.parse(result.content[0].text) as { id: string; url: string }
			expect(parsed.url).toBe(`https://maskin.example.com/ws-default-123/agents/${testUuid}`)
		})

		it('list_actors — url added to each actor in content', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve([{ id: 'actor-2', type: 'agent', name: 'Worker' }]),
			} as Response)

			const handler = getUrlHandler('list_actors')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as Array<{ id: string; url: string }>
			expect(parsed[0].url).toBe('https://maskin.example.com/ws-default-123/agents/actor-2')
		})
	})

	describe('trigger url', () => {
		it('create_trigger — url added to result', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: 'trig-1', name: 'Daily', workspaceId: 'ws-default-123' }),
			} as Response)

			const handler = getUrlHandler('create_trigger')
			const result = (await handler({
				name: 'Daily',
				type: 'cron',
				config: { expression: '0 0 * * *' },
				action_prompt: 'Check',
				target_actor_id: testUuid,
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as { id: string; url: string }
			expect(parsed.url).toBe('https://maskin.example.com/ws-default-123/triggers/trig-1')
		})

		it('list_triggers — url added to each trigger in content', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () =>
					Promise.resolve([{ id: 'trig-2', name: 'Weekly', workspaceId: 'ws-default-123' }]),
			} as Response)

			const handler = getUrlHandler('list_triggers')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as Array<{ id: string; url: string }>
			expect(parsed[0].url).toBe('https://maskin.example.com/ws-default-123/triggers/trig-2')
		})
	})

	describe('session url', () => {
		it('create_session — url links to actor page when actorId present', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: 'sess-1', actorId: 'actor-9', status: 'pending' }),
			} as Response)

			const handler = getUrlHandler('create_session')
			const result = (await handler({
				actor_id: testUuid,
				action_prompt: 'Fix bugs',
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as { id: string; url: string }
			expect(parsed.url).toBe('https://maskin.example.com/ws-default-123/agents/actor-9')
		})

		it('create_session — url falls back to agents list when actorId absent', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve({ id: 'sess-2', status: 'pending' }),
			} as Response)

			const handler = getUrlHandler('create_session')
			const result = (await handler({
				actor_id: testUuid,
				action_prompt: 'Fix bugs',
			})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as { id: string; url: string }
			expect(parsed.url).toBe('https://maskin.example.com/ws-default-123/agents')
		})

		it('list_sessions — url added to each session', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve([{ id: 'sess-3', actorId: 'actor-8', status: 'running' }]),
				} as Response)
				.mockResolvedValue({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve([]),
				} as Response)

			const handler = getUrlHandler('list_sessions')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = JSON.parse(result.content[0].text) as Array<{ id: string; url: string }>
			expect(parsed[0].url).toBe('https://maskin.example.com/ws-default-123/agents/actor-8')
		})

		it('run_agent — url added to session in response', async () => {
			vi.useFakeTimers()
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ id: 'sess-4', actorId: 'actor-7', status: 'pending' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ id: 'sess-4', actorId: 'actor-7', status: 'completed' }),
				} as Response)
				.mockResolvedValue({
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve([]),
				} as Response)

			const handler = getUrlHandler('run_agent')
			const resultPromise = handler({
				actor_id: testUuid,
				action_prompt: 'Deploy',
				poll_interval_seconds: 5,
				timeout_seconds: 60,
			})

			await vi.advanceTimersByTimeAsync(5000)

			const result = (await resultPromise) as { content: Array<{ text: string }> }
			const parsed = JSON.parse(result.content[0].text) as {
				session: { id: string; url: string }
			}
			expect(parsed.session.url).toBe('https://maskin.example.com/ws-default-123/agents/actor-7')
		})
	})
})
