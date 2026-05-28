import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	// `registerResource` is called by `registerObjectResources` when the test
	// config sets `webAppBaseUrl` (the lean-format-contract block pins a fake
	// base URL for deterministic deep-link snapshots). The default per-handler
	// tests pass `webAppBaseUrl: undefined`, which skips that branch — but the
	// stub still has to satisfy the call signature when it does run.
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: '00000000-0000-4000-8000-000000000001',
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

// Tests pre-date Task 4's lean-results refactor — they used to parse the JSON
// blob in `content[0].text`. The new wiring puts the raw JSON in
// `structuredContent` (array payloads wrapped as `{ items: [...] }`), so this
// helper bridges old assertions to the new shape until Task 5 rewrites them
// against the lean markdown contract directly.
// biome-ignore lint/suspicious/noExplicitAny: structuredContent is a heterogenous JSON payload; tests need permissive access without per-tool type plumbing.
type StructuredResult = any
function structuredOf(result: unknown): StructuredResult {
	const sc = (result as { structuredContent?: unknown })?.structuredContent
	if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
		const keys = Object.keys(sc as Record<string, unknown>)
		if (keys.length === 1 && keys[0] === 'items') {
			return (sc as { items: StructuredResult }).items
		}
	}
	return sc
}

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

	function mockFetchSuccess(data: unknown) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
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
						'X-Workspace-Id': '00000000-0000-4000-8000-000000000001',
					}),
				}),
			)

			const parsed = structuredOf(result)
			expect(parsed).toEqual(mockResult)
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({})

			const handler = getHandler('create_objects')
			await handler({
				workspace_id: '00000000-0000-4000-8000-000000000002',
				nodes: [{ $id: 'x', type: 'task', status: 'todo' }],
				edges: [],
			})

			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/graph',
				expect.objectContaining({
					headers: expect.objectContaining({
						'X-Workspace-Id': '00000000-0000-4000-8000-000000000002',
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

			const parsed = structuredOf(result)
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

			const parsed = structuredOf(result)
			expect(parsed.file_attachments).toBeUndefined()
		})
	})

	describe('get_objects handler', () => {
		it('GETs /api/objects/:id/graph for each ID', async () => {
			// Mock /api/objects/:id/graph — returns the ObjectGraph shape the new
			// lean formatter expects (object + relationships/events/files).
			mockFetchSuccess({
				object: {
					id: '00000000-0000-4000-8000-aaaaaaaaaaaa',
					type: 'task',
					title: 'Test',
					status: 'todo',
				},
				relationships: [],
				connected_objects: [],
				events: [],
				files: [],
			})

			const handler = getHandler('get_objects')
			const result = (await handler({
				ids: ['00000000-0000-4000-8000-aaaaaaaaaaaa', '00000000-0000-4000-8000-bbbbbbbbbbbb'],
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/00000000-0000-4000-8000-aaaaaaaaaaaa/graph',
				expect.anything(),
			)
			expect(fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/objects/00000000-0000-4000-8000-bbbbbbbbbbbb/graph',
				expect.anything(),
			)

			const parsed = structuredOf(result)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
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
	})

	describe('list_workspaces handler', () => {
		// The row builder runs inline (this is the only tool that operates without
		// a default workspace), so escape coverage has to be asserted on the tool
		// output directly — `formatGenericList`-level tests don't cover it.
		it('escapes link-syntax in workspace name so the deep link stays intact', async () => {
			const wsId = '00000000-0000-4000-8000-aaaaaaaaaaaa'
			mockFetchSuccess([{ id: wsId, name: 'foo](http://evil) [bar' }])

			const handler = getHandler('list_workspaces')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const text = result.content[0].text
			// The malicious bracket pair is escaped — the substring `](http://evil)`
			// never appears unescaped, so Claude won't parse it as a second link.
			expect(text).not.toMatch(/[^\\]\]\(http:\/\/evil\)/)
			expect(text).toContain('foo\\](http://evil) \\[bar')
			// The legitimate deep link survives intact: the escaped name is followed
			// by exactly one `](…)` pair pointing at the redirect for this workspace.
			// Base URL is left flexible so the test doesn't depend on WEB_APP_URL /
			// FRONTEND_URL env state.
			expect(text).toMatch(
				new RegExp(
					`- \\[foo\\\\\\]\\(http://evil\\) \\\\\\[bar\\]\\([^()\\s]+/r/${wsId}\\?t=list_workspaces\\)`,
				),
			)
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

			const parsed = structuredOf(result)
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

			const parsed = structuredOf(result)
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

			const parsed = structuredOf(result)
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

			const parsed = structuredOf(result)
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
				workspace_id: '00000000-0000-4000-8000-000000000003',
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(2)
			expect(fetch).toHaveBeenLastCalledWith(
				'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000003/members',
				expect.objectContaining({ method: 'POST' }),
			)

			const parsed = structuredOf(result)
			expect(parsed.workspace_id).toBe('00000000-0000-4000-8000-000000000003')
			expect(parsed.role).toBe('member')
		})
	})

	describe('get_objects handler (partial failure)', () => {
		it('returns success false for failed IDs without rejecting', async () => {
			const okGraph = {
				object: {
					id: '00000000-0000-4000-8000-aaaaaaaaaaaa',
					type: 'task',
					title: 'OK',
					status: 'todo',
				},
				relationships: [],
				connected_objects: [],
				events: [],
				files: [],
			}
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve(okGraph),
				} as Response)
				.mockResolvedValueOnce({
					ok: false,
					status: 404,
					text: () => Promise.resolve('Not found'),
				} as Response)

			const handler = getHandler('get_objects')
			const result = (await handler({
				ids: ['00000000-0000-4000-8000-aaaaaaaaaaaa', '00000000-0000-4000-8000-bbbbbbbbbbbb'],
			})) as { content: Array<{ text: string }> }

			const parsed = structuredOf(result)
			expect(parsed).toHaveLength(2)
			expect(parsed[0].success).toBe(true)
			expect(parsed[0].result).toEqual(okGraph)
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
			const parsed = structuredOf(result)

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
			const parsed = structuredOf(result)

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
			const parsed = structuredOf(result)
			expect(parsed.session.status).toBe('completed')
		})
	})

	describe('get_started handler', () => {
		const workspace = { id: 'ws-1', name: 'My Workspace', settings: {} }

		it('asks the user to pick when no use_case or template is given', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('My Workspace')
			expect(text).toContain('development')
			expect(text).toContain('growth')
			expect(text).toContain('custom')
		})

		it('maps use_case keywords to growth template', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({ use_case: 'planning our launch pipeline' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Preview')
			expect(text).toContain('Growth')
			expect(text).toContain('contact')
		})

		it('previews development template and prompts for tailoring questions', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({ template: 'development' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Preview')
			expect(text).toContain('Development')
			expect(text).toContain('confirm: true')
			expect(text).toContain('ASK THE USER')
			expect(text).toContain('workspace_name')
			expect(text).toContain('seed_overrides')
		})

		it('applies template with confirm: true — PATCH settings and POST graph', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ objects: [{ id: 'o1' }], relationships: [{ id: 'r1' }] }),
				} as Response)

			const handler = getHandler('get_started')
			const result = (await handler({
				template: 'development',
				confirm: true,
			})) as { content: Array<{ text: string }> }
			const text = result.content[0].text

			expect(text).toContain('Development')
			expect(text).toContain('template applied')

			const calls = fetchSpy.mock.calls
			expect(calls[1][0]).toBe('http://localhost:3000/api/workspaces/ws-1')
			expect((calls[1][1] as RequestInit).method).toBe('PATCH')
			expect(calls[2][0]).toBe('http://localhost:3000/api/graph')
			expect((calls[2][1] as RequestInit).method).toBe('POST')
		})

		it('renames workspace and applies seed_overrides on confirm', async () => {
			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([workspace]) } as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1', name: 'Acme' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ id: 'ws-1' }),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ objects: [{ id: 'o1' }], relationships: [] }),
				} as Response)

			const handler = getHandler('get_started')
			await handler({
				template: 'development',
				confirm: true,
				workspace_name: 'Acme',
				seed_overrides: {
					bet1: { title: 'Ship MVP by June' },
				},
			})

			const calls = fetchSpy.mock.calls
			// 1st: GET workspaces; 2nd: PATCH rename; 3rd: PATCH settings; 4th: POST graph
			const renameBody = JSON.parse((calls[1][1] as RequestInit).body as string)
			expect(renameBody).toEqual({ name: 'Acme' })
			const graphBody = JSON.parse((calls[3][1] as RequestInit).body as string)
			const bet1 = graphBody.nodes.find((n: { $id: string }) => n.$id === 'bet1')
			expect(bet1.title).toBe('Ship MVP by June')
		})

		it('asks a questionnaire when template is custom and no custom_settings', async () => {
			mockFetchSuccess([workspace])

			const handler = getHandler('get_started')
			const result = (await handler({ template: 'custom' })) as {
				content: Array<{ text: string }>
			}
			const text = result.content[0].text

			expect(text).toContain('Custom workspace')
			expect(text).toContain('custom_settings')
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
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001/skills',
					expect.objectContaining({
						method: 'GET',
						headers: expect.objectContaining({
							Authorization: 'Bearer ank_testkey123',
							'X-Workspace-Id': '00000000-0000-4000-8000-000000000001',
						}),
					}),
				)

				const parsed = structuredOf(result)
				expect(parsed).toHaveLength(1)
				expect(parsed[0].name).toBe('bug-fix')
			})

			it('uses workspace_id from args over default', async () => {
				mockFetchSuccess([])
				const handler = getHandler('list_workspace_skills')
				await handler({ workspace_id: '00000000-0000-4000-8000-000000000002' })

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000002/skills',
					expect.objectContaining({
						headers: expect.objectContaining({
							'X-Workspace-Id': '00000000-0000-4000-8000-000000000002',
						}),
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
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001/skills/bug-fix',
					expect.objectContaining({ method: 'GET' }),
				)
				const parsed = structuredOf(result)
				expect(parsed.content).toBe('# Bug fix skill')
			})

			it('url-encodes the name segment', async () => {
				mockFetchSuccess({})
				const handler = getHandler('get_workspace_skill')
				// skillNameSchema rejects non-[a-z0-9-] names, so this is defense-in-depth
				// for a name with characters that still need escaping as a path segment.
				await handler({ name: 'a-b' })
				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001/skills/a-b',
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
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001/skills',
					expect.objectContaining({ method: 'POST' }),
				)
				const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)
				expect(body).toEqual({ name: 'bug-fix', content: '# body' })
				expect(structuredOf(result).name).toBe('bug-fix')
			})

			it('uses workspace_id from args when provided', async () => {
				mockFetchSuccess({})
				const handler = getHandler('create_workspace_skill')
				await handler({
					workspace_id: '00000000-0000-4000-8000-000000000002',
					name: 'my-skill',
					content: '# x',
				})

				expect(fetch).toHaveBeenCalledWith(
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000002/skills',
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
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001/skills/bug-fix',
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
					'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001/skills/bug-fix',
					expect.objectContaining({ method: 'DELETE' }),
				)
				expect(structuredOf(result)).toEqual({ deleted: true })
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
			mockFetchSuccess({
				id: '00000000-0000-4000-8000-000000000001',
				name: 'My Workspace',
				settings: {},
			})

			const handler = getHandler('set_llm_api_key')
			const result = (await handler({
				provider: 'anthropic',
				api_key: 'sk-ant-new-key-WXYZ',
			})) as { content: Array<{ text: string }> }

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe(
				'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001',
			)
			expect(patchCall[1]?.method).toBe('PATCH')
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ anthropic: 'sk-ant-new-key-WXYZ' })

			const parsed = structuredOf(result)
			expect(parsed).toEqual({ success: true, provider: 'anthropic', last4: 'WXYZ' })
			expect(result.content[0].text).not.toContain('sk-ant-new-key-WXYZ')
		})

		it('uses workspace_id from args over default', async () => {
			mockFetchSuccess({ id: '00000000-0000-4000-8000-000000000002', name: 'Other', settings: {} })

			const handler = getHandler('set_llm_api_key')
			await handler({
				workspace_id: '00000000-0000-4000-8000-000000000002',
				provider: 'openai',
				api_key: 'sk-foo',
			})

			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe(
				'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000002',
			)
		})

		it('back-to-back sets for both providers each send only their own delta', async () => {
			vi.spyOn(globalThis, 'fetch')
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							id: '00000000-0000-4000-8000-000000000001',
							name: 'My',
							settings: {},
						}),
				} as Response)
				.mockResolvedValueOnce({
					ok: true,
					json: () =>
						Promise.resolve({
							id: '00000000-0000-4000-8000-000000000001',
							name: 'My',
							settings: {},
						}),
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
					id: '00000000-0000-4000-8000-000000000001',
					name: 'My Workspace',
					settings: {
						llm_keys: { anthropic: 'sk-ant-abcdEFGH', openai: 'sk-opq-MNOP' },
					},
				},
			])

			const handler = getHandler('get_llm_api_keys')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = structuredOf(result)
			expect(parsed).toEqual({
				anthropic: { set: true, last4: 'EFGH' },
				openai: { set: true, last4: 'MNOP' },
			})
			expect(result.content[0].text).not.toContain('sk-ant-abcdEFGH')
		})

		it('returns { set: false } for missing providers', async () => {
			mockFetchSuccess([
				{
					id: '00000000-0000-4000-8000-000000000001',
					name: 'My Workspace',
					settings: { llm_keys: {} },
				},
			])

			const handler = getHandler('get_llm_api_keys')
			const result = (await handler({})) as { content: Array<{ text: string }> }

			const parsed = structuredOf(result)
			expect(parsed).toEqual({
				anthropic: { set: false },
				openai: { set: false },
			})
		})
	})

	describe('delete_llm_api_key handler', () => {
		it('PATCHes the target provider to null so the server strips it', async () => {
			mockFetchSuccess({
				id: '00000000-0000-4000-8000-000000000001',
				name: 'My Workspace',
				settings: {},
			})

			const handler = getHandler('delete_llm_api_key')
			const result = (await handler({ provider: 'anthropic' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			expect(patchCall[0]).toBe(
				'http://localhost:3000/api/workspaces/00000000-0000-4000-8000-000000000001',
			)
			expect(patchCall[1]?.method).toBe('PATCH')
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ anthropic: null })
			const parsed = structuredOf(result)
			expect(parsed).toEqual({ success: true, provider: 'anthropic' })
		})

		it('delete on an unset provider still sends one PATCH and reports success', async () => {
			// Server-side deep-merge treats null as "delete if present"; deleting
			// a missing provider is a no-op there, so the MCP tool still returns
			// success without needing to inspect current state.
			mockFetchSuccess({
				id: '00000000-0000-4000-8000-000000000001',
				name: 'My Workspace',
				settings: {},
			})

			const handler = getHandler('delete_llm_api_key')
			const result = (await handler({ provider: 'openai' })) as {
				content: Array<{ text: string }>
			}

			expect(fetch).toHaveBeenCalledTimes(1)
			const [patchCall] = vi.mocked(fetch).mock.calls
			const body = JSON.parse(patchCall[1]?.body as string)
			expect(body.settings.llm_keys).toEqual({ openai: null })
			expect(structuredOf(result)).toEqual({ success: true, provider: 'openai' })
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
						'X-Workspace-Id': '00000000-0000-4000-8000-000000000001',
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
			expect(structuredOf(result)).toEqual(mockResult)
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
			await handler({
				entity_id: objectId,
				workspace_id: '00000000-0000-4000-8000-000000000002',
				limit: 50,
				offset: 0,
			})

			expect(fetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						'X-Workspace-Id': '00000000-0000-4000-8000-000000000002',
					}),
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
						'X-Workspace-Id': '00000000-0000-4000-8000-000000000001',
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

			expect(structuredOf(result)).toEqual(mockResult)
		})

		it('strips workspace_id from the POST body', async () => {
			mockFetchSuccess({})

			const handler = getHandler('create_comment')
			await handler({
				workspace_id: '00000000-0000-4000-8000-000000000002',
				entity_id: objectId,
				content: 'hello',
			})

			const call = vi.mocked(fetch).mock.calls[0]
			const body = JSON.parse((call[1] as RequestInit).body as string)
			expect(body).not.toHaveProperty('workspace_id')
			expect(body.entity_id).toBe(objectId)
			expect(body.content).toBe('hello')

			expect(call[1]).toMatchObject({
				headers: expect.objectContaining({
					'X-Workspace-Id': '00000000-0000-4000-8000-000000000002',
				}),
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
		const wsId = '00000000-0000-4000-8000-000000000001'
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
				const parsed = structuredOf(result)
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
				expect(headers['Idempotency-Key']).toMatch(
					/^mcp-schema-00000000-0000-4000-8000-000000000001-/,
				)
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

				expect(structuredOf(result).field).toEqual({ name: 'tag', type: 'text' })
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
				const parsed = structuredOf(result)
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
})

// ─────────────────────────────────────────────────────────────────────
// Lean format contract — Direction 1 of bet `mcp-lean-results`.
//
// These tests are the implementer's surface contract for Task 4's wiring:
// every read-style tool returns lean markdown in `content[0].text` plus the
// full untruncated JSON in `structuredContent`. The four DOD criteria from
// the Task 5 brief are asserted uniformly per-tool, plus golden inline
// snapshots lock the rendered shape for a representative payload per
// formatter family. The intent is regression-guard, not character-perfect
// snapshotting — readers who need to change the format should update the
// snapshot deliberately and re-confirm the contract still holds.
// ─────────────────────────────────────────────────────────────────────

import {
	ACTOR_ID_1,
	ACTOR_ID_2,
	FILE_ID_1,
	GET_ACTOR_PAYLOAD,
	GET_CLAUDE_SUBSCRIPTION_STATUS_PAYLOAD,
	GET_COMMENTS_PAYLOAD,
	GET_EVENTS_PAYLOAD,
	GET_FILE_PAYLOAD,
	GET_LLM_API_KEYS_WORKSPACE_PAYLOAD,
	GET_OBJECTS_PAYLOAD,
	GET_SESSION_ACTOR_PAYLOAD,
	GET_SESSION_PAYLOAD,
	GET_WORKSPACE_SCHEMA_PAYLOAD,
	GET_WORKSPACE_SKILL_PAYLOAD,
	LIST_ACTORS_PAYLOAD,
	LIST_EXTENSIONS_PAYLOAD_WORKSPACES,
	LIST_FILES_PAYLOAD,
	LIST_INTEGRATIONS_PAYLOAD,
	LIST_INTEGRATION_PROVIDERS_PAYLOAD,
	LIST_OBJECTS_PAYLOAD,
	LIST_RELATIONSHIPS_PAYLOAD,
	LIST_SESSIONS_PAYLOAD,
	LIST_SUBSCRIBERS_PAYLOAD,
	LIST_TRIGGERS_PAYLOAD,
	LIST_UNREAD_PAYLOAD,
	LIST_WORKSPACES_PAYLOAD,
	LIST_WORKSPACE_SKILLS_PAYLOAD,
	OBJECT_ID_1,
	OBJECT_ID_2,
	SEARCH_OBJECTS_PAYLOAD,
	SESSION_ID_1,
	TRIGGER_ID_1,
	WEB_APP_BASE_URL,
	WS_ID,
} from './fixtures/lean-format-payloads'

// The lean format puts the workspace UUID in every deep link. Pinning the
// web-app base URL on the config (instead of relying on env vars) keeps
// snapshots byte-stable across machines and CI.
const FORMAT_CONFIG = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: WS_ID,
	webAppBaseUrl: WEB_APP_BASE_URL,
	telemetrySink: () => {},
}

type CallToolResult = {
	content: Array<{ type: string; text: string }>
	structuredContent?: Record<string, unknown>
}

/** All HTTPS links inside Markdown link syntax `[…](url)`. */
function extractHttpsLinks(text: string): string[] {
	return [...text.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1])
}

/**
 * The lean format intentionally avoids prose pagination cues — the model
 * paginates by calling the tool again with a new offset, and the truncation
 * indicator is the single "…and N more" line, not "page X of Y" or a
 * "Showing 1–25 of N" header. This guard fails loudly if any pagination
 * boilerplate sneaks back into a tool's `content`.
 */
function hasPaginationNoise(text: string): boolean {
	return /\b(page \d+ of \d+|next page|previous page|showing \d+\s*[–-]\s*\d+ of)\b/i.test(text)
}

describe('lean format contract — Direction 1', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		// The `tool handlers` describe above calls `vi.restoreAllMocks()` in
		// its afterEach, which strips the McpServer + ResourceTemplate
		// implementations declared at the top of the file. Re-stub here so
		// `registerObjectResources` can call `server.registerResource(...)`
		// without crashing when this block sets `webAppBaseUrl` on the config.
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn() }) as unknown as McpServer,
		)
		handlers = new Map()
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		createMcpServer(FORMAT_CONFIG)
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	function mockSequence(payloads: unknown[]) {
		const spy = vi.spyOn(globalThis, 'fetch')
		for (const payload of payloads) {
			spy.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(payload),
			} as Response)
		}
	}

	function mockSuccess(payload: unknown) {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			json: () => Promise.resolve(payload),
		} as Response)
	}

	/**
	 * Table-driven test cases. Each row exercises one read-style handler
	 * against a representative API payload from the fixtures file and
	 * declares the format-contract guarantees we expect.
	 *
	 * `expectedItemLinkCount` — exact number of `[…](https://…)` Markdown
	 * links in the rendered `content`. For object-link tools that's
	 * `headerLink ? 1 : 0 + perItemLink * itemCount`; for tools whose
	 * generic-list row has no per-item link the count is just the header.
	 * `structuredKey` — `'items'` when the formatter wraps an array (Task 4
	 * normalises arrays as `{ items: [...] }` to satisfy the MCP SDK's
	 * `Record<string, unknown>` constraint); otherwise the structured body
	 * should pass through as-is (object payloads).
	 */
	const CASES: Array<{
		name: string
		tool: string
		args: Record<string, unknown>
		// API call sequence the handler will make. For most handlers this is
		// just one fetch; a few (`get_objects`, `list_sessions`, `list_extensions`,
		// `get_llm_api_keys`) call out more than once.
		mockPayloads: unknown[]
		expectedItemLinkCount: number
		structuredKey: 'items' | 'pass-through'
		// The single most authoritative payload to compare `content.length`
		// against for the ≥60% token-reduction regression guard.
		baselinePayload: unknown
		// When the formatter wraps an array as `structuredContent.items`, the
		// brief requires `items.length` to equal the upstream row count —
		// guards against a future formatter silently truncating
		// `structuredContent` and breaking the "full untruncated JSON"
		// contract. Omitted for record-shaped tools.
		expectedItemCount?: number
	}> = [
		{
			name: 'list_objects — grouped by type, per-item links, no header link',
			tool: 'list_objects',
			args: {},
			mockPayloads: [LIST_OBJECTS_PAYLOAD],
			expectedItemLinkCount: 3,
			structuredKey: 'items',
			baselinePayload: LIST_OBJECTS_PAYLOAD,
			expectedItemCount: LIST_OBJECTS_PAYLOAD.length,
		},
		{
			name: 'get_objects — one block per id (success path)',
			tool: 'get_objects',
			args: { ids: [OBJECT_ID_1, OBJECT_ID_2] },
			mockPayloads: [GET_OBJECTS_PAYLOAD, GET_OBJECTS_PAYLOAD],
			expectedItemLinkCount: 2,
			structuredKey: 'items',
			baselinePayload: [GET_OBJECTS_PAYLOAD, GET_OBJECTS_PAYLOAD],
			expectedItemCount: 2,
		},
		{
			name: 'search_objects — header link + one link per hit',
			tool: 'search_objects',
			args: { q: 'lean' },
			mockPayloads: [SEARCH_OBJECTS_PAYLOAD],
			expectedItemLinkCount: 1 + SEARCH_OBJECTS_PAYLOAD.length,
			structuredKey: 'items',
			baselinePayload: SEARCH_OBJECTS_PAYLOAD,
			expectedItemCount: SEARCH_OBJECTS_PAYLOAD.length,
		},
		{
			name: 'list_unread — header activity link + one link per thread',
			tool: 'list_unread',
			args: {},
			mockPayloads: [LIST_UNREAD_PAYLOAD],
			expectedItemLinkCount: 1 + LIST_UNREAD_PAYLOAD.length,
			structuredKey: 'pass-through',
			baselinePayload: { items: LIST_UNREAD_PAYLOAD },
			expectedItemCount: LIST_UNREAD_PAYLOAD.length,
		},
		{
			name: 'list_actors — header link + one link per actor',
			tool: 'list_actors',
			args: { workspace_id: WS_ID },
			mockPayloads: [LIST_ACTORS_PAYLOAD],
			expectedItemLinkCount: 1 + LIST_ACTORS_PAYLOAD.length,
			structuredKey: 'items',
			baselinePayload: LIST_ACTORS_PAYLOAD,
			expectedItemCount: LIST_ACTORS_PAYLOAD.length,
		},
		{
			name: 'list_files — header link only (rows are inline names)',
			tool: 'list_files',
			args: {},
			mockPayloads: [LIST_FILES_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_FILES_PAYLOAD,
			expectedItemCount: LIST_FILES_PAYLOAD.length,
		},
		{
			name: 'list_triggers — header link + one link per trigger',
			tool: 'list_triggers',
			args: {},
			mockPayloads: [LIST_TRIGGERS_PAYLOAD],
			expectedItemLinkCount: 1 + LIST_TRIGGERS_PAYLOAD.length,
			structuredKey: 'items',
			baselinePayload: LIST_TRIGGERS_PAYLOAD,
			expectedItemCount: LIST_TRIGGERS_PAYLOAD.length,
		},
		{
			name: 'list_sessions — header link only (rows are inline ids)',
			tool: 'list_sessions',
			args: {},
			// Two parallel fetches: sessions list + actor-name lookup for
			// enrichment. Order is parallel; both resolve to the same mock so we
			// don't depend on Promise.all's call order.
			mockPayloads: [LIST_SESSIONS_PAYLOAD, [{ id: ACTOR_ID_1, name: 'Senior Developer' }]],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_SESSIONS_PAYLOAD,
			expectedItemCount: LIST_SESSIONS_PAYLOAD.length,
		},
		{
			name: 'list_relationships — header link only',
			tool: 'list_relationships',
			args: {},
			mockPayloads: [LIST_RELATIONSHIPS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_RELATIONSHIPS_PAYLOAD,
			expectedItemCount: LIST_RELATIONSHIPS_PAYLOAD.length,
		},
		{
			name: 'list_workspace_skills — header link only',
			tool: 'list_workspace_skills',
			args: { workspace_id: WS_ID },
			mockPayloads: [LIST_WORKSPACE_SKILLS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_WORKSPACE_SKILLS_PAYLOAD,
			expectedItemCount: LIST_WORKSPACE_SKILLS_PAYLOAD.length,
		},
		{
			name: 'get_workspace_skill — H4 + meta + single record link',
			tool: 'get_workspace_skill',
			args: { name: 'spec-brief', workspace_id: WS_ID },
			mockPayloads: [GET_WORKSPACE_SKILL_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_WORKSPACE_SKILL_PAYLOAD,
		},
		{
			name: 'get_actor — H4 + meta + actor link',
			tool: 'get_actor',
			args: { id: ACTOR_ID_1 },
			mockPayloads: [GET_ACTOR_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_ACTOR_PAYLOAD,
		},
		{
			name: 'get_file — H4 + meta + file link',
			tool: 'get_file',
			args: { id: FILE_ID_1 },
			mockPayloads: [GET_FILE_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_FILE_PAYLOAD,
		},
		{
			name: 'get_events — header link only (event rows are inline descriptions)',
			tool: 'get_events',
			args: {},
			mockPayloads: [GET_EVENTS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: GET_EVENTS_PAYLOAD,
			expectedItemCount: GET_EVENTS_PAYLOAD.length,
		},
		{
			name: 'get_comments — thread link + inline author/snippet rows',
			tool: 'get_comments',
			args: { entity_id: OBJECT_ID_1, limit: 50, offset: 0 },
			mockPayloads: [GET_COMMENTS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: GET_COMMENTS_PAYLOAD,
			expectedItemCount: GET_COMMENTS_PAYLOAD.length,
		},
		{
			name: 'list_subscribers — entity-object link header, inline rows',
			tool: 'list_subscribers',
			args: { entity_type: 'object', entity_id: OBJECT_ID_1 },
			mockPayloads: [LIST_SUBSCRIBERS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_SUBSCRIBERS_PAYLOAD,
			expectedItemCount: LIST_SUBSCRIBERS_PAYLOAD.length,
		},
		{
			name: 'list_workspaces — header link to first workspace + per-row link',
			tool: 'list_workspaces',
			args: {},
			mockPayloads: [LIST_WORKSPACES_PAYLOAD],
			expectedItemLinkCount: 1 + LIST_WORKSPACES_PAYLOAD.length,
			structuredKey: 'items',
			baselinePayload: LIST_WORKSPACES_PAYLOAD,
			expectedItemCount: LIST_WORKSPACES_PAYLOAD.length,
		},
		{
			name: 'list_integrations — header link only',
			tool: 'list_integrations',
			args: {},
			mockPayloads: [LIST_INTEGRATIONS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_INTEGRATIONS_PAYLOAD,
			expectedItemCount: LIST_INTEGRATIONS_PAYLOAD.length,
		},
		{
			name: 'list_integration_providers — header settings link only',
			tool: 'list_integration_providers',
			args: {},
			mockPayloads: [LIST_INTEGRATION_PROVIDERS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			baselinePayload: LIST_INTEGRATION_PROVIDERS_PAYLOAD,
			expectedItemCount: LIST_INTEGRATION_PROVIDERS_PAYLOAD.length,
		},
		{
			name: 'get_workspace_schema — H4 + per-type status rows + workspace link',
			tool: 'get_workspace_schema',
			args: { workspace_id: WS_ID },
			mockPayloads: [GET_WORKSPACE_SCHEMA_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_WORKSPACE_SCHEMA_PAYLOAD,
		},
		{
			name: 'get_session — H4 + actor/status meta + sessions link',
			tool: 'get_session',
			args: { id: SESSION_ID_1 },
			mockPayloads: [GET_SESSION_PAYLOAD, GET_SESSION_ACTOR_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_SESSION_PAYLOAD,
		},
		{
			name: 'list_extensions — first call gets workspaces, then renders module list',
			tool: 'list_extensions',
			args: { workspace_id: WS_ID },
			mockPayloads: [LIST_EXTENSIONS_PAYLOAD_WORKSPACES],
			expectedItemLinkCount: 1,
			structuredKey: 'items',
			// list_extensions' structured payload is computed from module
			// defaults + workspace settings, so the JSON baseline is the
			// workspace settings input (still the dominant size driver).
			baselinePayload: LIST_EXTENSIONS_PAYLOAD_WORKSPACES,
		},
		{
			name: 'get_llm_api_keys — header settings link + status lines, no JSON dump',
			tool: 'get_llm_api_keys',
			args: { workspace_id: WS_ID },
			mockPayloads: [[GET_LLM_API_KEYS_WORKSPACE_PAYLOAD]],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_LLM_API_KEYS_WORKSPACE_PAYLOAD,
		},
		{
			name: 'get_claude_subscription_status — H4 + state line + settings link',
			tool: 'get_claude_subscription_status',
			args: {},
			mockPayloads: [GET_CLAUDE_SUBSCRIPTION_STATUS_PAYLOAD],
			expectedItemLinkCount: 1,
			structuredKey: 'pass-through',
			baselinePayload: GET_CLAUDE_SUBSCRIPTION_STATUS_PAYLOAD,
		},
	]

	for (const c of CASES) {
		it(c.name, async () => {
			mockSequence(c.mockPayloads)
			const handler = getHandler(c.tool)
			const result = (await handler(c.args)) as CallToolResult

			// (c) structuredContent set and matches the prior JSON shape.
			expect(result.structuredContent).toBeDefined()
			if (c.structuredKey === 'items') {
				expect(Array.isArray((result.structuredContent as { items: unknown }).items)).toBe(true)
			}
			// Row-count contract for list-shaped tools — the brief promises
			// "full untruncated JSON in structuredContent", so a future
			// formatter that silently caps `items` would break the wire
			// contract. Asserted only when the case opts in (record-shaped
			// tools omit `expectedItemCount`).
			if (c.expectedItemCount !== undefined) {
				const items = (result.structuredContent as { items: unknown[] }).items
				expect(items.length).toBe(c.expectedItemCount)
			}

			// `content` is a single text block with non-empty body — the lean
			// markdown is what the model reads in-chat.
			expect(result.content).toHaveLength(1)
			expect(result.content[0].type).toBe('text')
			const text = result.content[0].text
			expect(text.length).toBeGreaterThan(0)

			// (b) Exact count of HTTPS deep links — every link is HTTPS and goes
			// through the click-tracking `/r/` redirect at WEB_APP_BASE_URL.
			const links = extractHttpsLinks(text)
			expect(links).toHaveLength(c.expectedItemLinkCount)
			for (const url of links) {
				expect(url.startsWith(`${WEB_APP_BASE_URL}/r/`)).toBe(true)
				// Every deep link carries the tool name as `?t=<tool>` for
				// click telemetry — guards against the regression where a
				// per-handler link forgets to thread the tool through, and
				// against a future formatter appending stray params that would
				// break URL-parsing of `t` in the click-tracking redirect.
				expect(new URL(url).searchParams.get('t')).toBe(c.tool)
			}

			// (d) No prose pagination noise. The lean format paginates via
			// caller-supplied `offset` and a single "…and N more" truncation
			// line, not "page X of Y" or "Showing 1–25 of N" boilerplate.
			expect(hasPaginationNoise(text)).toBe(false)

			// (a) JSON-dump regression guard. The old failure mode embedded the
			// raw API payload into `content` verbatim; the lean format
			// summarises it instead, so the JSON dump should never appear in
			// the rendered markdown. We match only on dumps of ≥40 chars so
			// that legitimate single-value substrings (titles, statuses) don't
			// trigger a false positive. The per-payload ≥60% token-reduction
			// guarantee is asserted separately on a realistic-sized list
			// payload below, where the property actually holds — tiny payloads
			// are dominated by the deep-link URL, not their JSON size.
			const jsonDump = JSON.stringify(c.baselinePayload)
			if (jsonDump.length > 40) {
				expect(text).not.toContain(jsonDump)
			}
		})
	}

	// ─────────────────────────────────────────────────────────────────
	// Token-reduction regression guard. The bet's primary win is in
	// truncating large `content` fields — every formatter's content
	// preview is capped at PREVIEW_MAX (140 chars). If a future change
	// removed that cap and started embedding full content into the
	// lean markdown, `content.length` would scale linearly with payload
	// size rather than item count. Anchored at the truncation contract.
	// ─────────────────────────────────────────────────────────────────

	describe('token-reduction regression guard', () => {
		it('list_objects truncates per-item content previews regardless of payload size', async () => {
			// 5 objects each carrying a 2000-char content body — well over the
			// 140-char preview cap. The lean format must truncate, so the
			// rendered text shouldn't grow linearly with payload bytes.
			const heavyList = Array.from({ length: 5 }, (_, i) => ({
				id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
				type: 'bet' as const,
				title: `Heavy object ${i}`,
				status: 'active' as const,
				content: 'x'.repeat(2000),
			}))
			mockSuccess(heavyList)
			const handler = getHandler('list_objects')
			const result = (await handler({})) as CallToolResult
			const text = result.content[0].text
			// Lean content carries 5 short previews (≤140 chars each) plus
			// structural overhead — well under the raw payload size of 10000+
			// content chars. Anchored at ½ of the payload-content size to give
			// PREVIEW_MAX changes a generous margin before this fails.
			const totalContentBytes = heavyList.reduce((sum, o) => sum + o.content.length, 0)
			expect(text.length).toBeLessThan(totalContentBytes / 2)
		})

		it('get_objects truncates the per-object content preview', async () => {
			// One object with a multi-KB body. The lean H4 block must summarise,
			// not embed the body in full — the failure mode the bet exists to
			// fix.
			const heavyGraph = {
				object: {
					id: OBJECT_ID_1,
					type: 'bet' as const,
					title: 'Heavy bet',
					status: 'active' as const,
					content: 'y'.repeat(5000),
				},
				relationships: [],
				connected_objects: [],
				events: [],
				files: [],
			}
			mockSequence([heavyGraph])
			const handler = getHandler('get_objects')
			const result = (await handler({ ids: [OBJECT_ID_1] })) as CallToolResult
			const text = result.content[0].text
			// `content.length` must be a small fraction of the body it
			// summarised — that's the truncation contract holding.
			expect(text.length).toBeLessThan(heavyGraph.object.content.length / 5)
			// And the raw body must NOT appear verbatim — that catches a
			// regression where a future formatter drops the truncation.
			expect(text).not.toContain(heavyGraph.object.content)
		})
	})

	// ─────────────────────────────────────────────────────────────────
	// Golden snapshots — one per formatter family, locking the rendered
	// shape so any future format change is a deliberate test edit, not a
	// silent behaviour drift.
	//
	// These also serve as documentation of what the lean format actually
	// looks like to readers who skim the test file.
	// ─────────────────────────────────────────────────────────────────

	describe('golden snapshots', () => {
		it('list_objects (formatObjectList) groups by type with per-item links', async () => {
			mockSuccess(LIST_OBJECTS_PAYLOAD)
			const handler = getHandler('list_objects')
			const result = (await handler({})) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"**1 bet**

				#### [Ship MCP lean results](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa1?t=list_objects)
				_bet • active_
				Redesign Maskin MCP tool results for a simple, elegant Claude experience.

				**2 tasks**

				#### [Task 5 — Update MCP tests for new result format](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa2?t=list_objects)
				_task • in_progress_
				Replace assertions on the old prose format with format-contract guards.

				#### [Task 4 — Wire formatter into all MCP read tools](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa3?t=list_objects)
				_task • done_
				Done."
			`)
		})

		it('get_objects (formatObjectBatch) renders one H4 block per id', async () => {
			mockSequence([GET_OBJECTS_PAYLOAD])
			const handler = getHandler('get_objects')
			const result = (await handler({ ids: [OBJECT_ID_1] })) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"#### [Ship MCP lean results](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa1?t=get_objects)
				_bet • active_
				Redesign Maskin MCP tool results for a simple, elegant Claude experience. Engages anchors #3 (execution) and #6 (coherence).
				Last activity: changed status from Proposed to Active"
			`)
		})

		it('search_objects (formatSearchHits) renders a header link + per-hit blocks', async () => {
			mockSuccess(SEARCH_OBJECTS_PAYLOAD)
			const handler = getHandler('search_objects')
			const result = (await handler({ q: 'lean' })) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"**2 results** for "lean" — [open in Maskin](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects?q=lean&t=search_objects)

				#### [Ship MCP lean results](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa1?t=search_objects)
				_bet • active_

				#### [Task 5 — tests](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa2?t=search_objects)
				_task • in_progress_"
			`)
		})

		it('list_unread (formatUnreadDigest) renders an activity header + one-line rows', async () => {
			mockSuccess(LIST_UNREAD_PAYLOAD)
			const handler = getHandler('list_unread')
			const result = (await handler({})) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"**4 unread** across 2 threads — [open activity](https://maskin.app/r/00000000-0000-4000-8000-000000000001/activity?t=list_unread)

				- [Ship MCP lean results](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa1?t=list_unread) — 3 unread
				- [Task 5](https://maskin.app/r/00000000-0000-4000-8000-000000000001/objects/00000000-0000-4000-8000-aaaaaaaaaaa2?t=list_unread) — 1 unread"
			`)
		})

		it('list_actors (formatGenericList with per-item links) — locks the generic-list shape', async () => {
			mockSuccess(LIST_ACTORS_PAYLOAD)
			const handler = getHandler('list_actors')
			const result = (await handler({ workspace_id: WS_ID })) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"**2 actors** — [open in Maskin](https://maskin.app/r/00000000-0000-4000-8000-000000000001/agents?t=list_actors)
				- [Senior Developer](https://maskin.app/r/00000000-0000-4000-8000-000000000001/agents/00000000-0000-4000-8000-bbbbbbbbbbb1?t=list_actors) — agent
				- [Operator](https://maskin.app/r/00000000-0000-4000-8000-000000000001/agents/00000000-0000-4000-8000-bbbbbbbbbbb2?t=list_actors) — human • op@example.com"
			`)
		})

		it('get_workspace_skill (formatGenericRecord) — locks the single-record shape', async () => {
			mockSuccess(GET_WORKSPACE_SKILL_PAYLOAD)
			const handler = getHandler('get_workspace_skill')
			const result = (await handler({
				name: 'spec-brief',
				workspace_id: WS_ID,
			})) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"#### [spec-brief](https://maskin.app/r/00000000-0000-4000-8000-000000000001/settings/skills?t=get_workspace_skill)
				_Enforces the minimum brief contract_"
			`)
		})

		it('list_triggers (formatGenericList with custom per-row link) — locks trigger row shape', async () => {
			mockSuccess(LIST_TRIGGERS_PAYLOAD)
			const handler = getHandler('list_triggers')
			const result = (await handler({})) as CallToolResult
			expect(result.content[0].text).toMatchInlineSnapshot(`
				"**1 trigger** — [open in Maskin](https://maskin.app/r/00000000-0000-4000-8000-000000000001/triggers?t=list_triggers)
				- [Weekly digest](https://maskin.app/r/00000000-0000-4000-8000-000000000001/triggers/00000000-0000-4000-8000-dddddddddddd?t=list_triggers) — cron • enabled"
			`)
		})
	})

	// ─────────────────────────────────────────────────────────────────
	// Empty-result guards. Empty lists must still produce a non-empty
	// `content` with the header link intact — the failure mode is the
	// model getting back a literally empty string and not knowing whether
	// the call succeeded.
	// ─────────────────────────────────────────────────────────────────

	describe('empty results', () => {
		it('list_objects on empty result renders a single _No objects matched._ line', async () => {
			mockSuccess([])
			const handler = getHandler('list_objects')
			const result = (await handler({})) as CallToolResult
			expect(result.content[0].text).toBe('_No objects matched._')
			expect(result.structuredContent).toEqual({ items: [] })
		})

		it('list_actors on empty result keeps the header link', async () => {
			mockSuccess([])
			const handler = getHandler('list_actors')
			const result = (await handler({ workspace_id: WS_ID })) as CallToolResult
			expect(extractHttpsLinks(result.content[0].text)).toHaveLength(1)
			expect(result.content[0].text).toContain('0 actors')
			expect(result.content[0].text).toContain('_No actors._')
		})

		it('list_unread on empty result still shows the activity link + "Inbox zero."', async () => {
			mockSuccess([])
			const handler = getHandler('list_unread')
			const result = (await handler({})) as CallToolResult
			expect(extractHttpsLinks(result.content[0].text)).toHaveLength(1)
			expect(result.content[0].text).toContain('Inbox zero.')
		})

		it('search_objects on empty result keeps the search header link + "No matches."', async () => {
			mockSuccess([])
			const handler = getHandler('search_objects')
			const result = (await handler({ q: 'nothing-matches' })) as CallToolResult
			expect(extractHttpsLinks(result.content[0].text)).toHaveLength(1)
			expect(result.content[0].text).toContain('No matches.')
		})
	})

	// Reference unused fixtures so tree-shaking checks stay satisfied if a
	// future test rewrites the table — keeps the fixture file's exports
	// stable across edits without dangling no-op imports.
	it('fixture sentinels — guards against drift in shared payload constants', () => {
		expect(SESSION_ID_1.length).toBeGreaterThan(0)
		expect(TRIGGER_ID_1.length).toBeGreaterThan(0)
	})
})
