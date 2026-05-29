import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TelemetryEvent, type TelemetrySink, measureToolResponse } from '../telemetry'

describe('measureToolResponse', () => {
	it('sums content[].text bytes and computes a token estimate of ceil(bytes/4)', () => {
		const r = measureToolResponse({
			content: [
				{ type: 'text', text: 'hello' }, // 5 bytes
				{ type: 'text', text: 'world!' }, // 6 bytes
			],
			structuredContent: { items: [1, 2, 3] },
		})
		expect(r.content_bytes).toBe(11)
		expect(r.content_tokens).toBe(3) // ceil(11/4) = 3
		expect(r.structured_content_bytes).toBe(JSON.stringify({ items: [1, 2, 3] }).length)
	})

	it('counts utf-8 byte length, not character count', () => {
		const r = measureToolResponse({ content: [{ type: 'text', text: '€' }] })
		// '€' is 3 bytes in UTF-8.
		expect(r.content_bytes).toBe(3)
		expect(r.content_tokens).toBe(1) // ceil(3/4)
	})

	it('returns empty object for non-object responses', () => {
		expect(measureToolResponse(null)).toEqual({})
		expect(measureToolResponse('foo')).toEqual({})
		expect(measureToolResponse(42)).toEqual({})
	})

	it('omits content fields when content is not an array', () => {
		const r = measureToolResponse({ structuredContent: { ok: true } })
		expect(r.content_bytes).toBeUndefined()
		expect(r.content_tokens).toBeUndefined()
		expect(r.structured_content_bytes).toBeGreaterThan(0)
	})

	it('survives a structuredContent with circular references', () => {
		const circular: Record<string, unknown> = { name: 'demo' }
		circular.self = circular
		const r = measureToolResponse({
			content: [{ type: 'text', text: 'x' }],
			structuredContent: circular,
		})
		expect(r.content_bytes).toBe(1)
		expect(r.structured_content_bytes).toBeUndefined()
	})
})

// Hoisted mocks for ext-apps + sdk + node:fs so we can spin up the real
// createMcpServer wiring without any side effects, then drive the registered
// handlers directly to verify the telemetry wrapper.
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

const wsId = '00000000-0000-0000-0000-0000000000aa'

describe('MCP telemetry wrapper', () => {
	let recorded: TelemetryEvent[]
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let definitions: Map<string, { _meta?: { ui?: unknown } }>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		recorded = []
		handlers = new Map()
		definitions = new Map()

		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
			definitions.set(name as string, def as { _meta?: { ui?: unknown } })
		})

		// Original tool handlers call fetch via apiCall. Stub a generic success
		// response so the wrapper sees a non-throwing handler.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})

		const captureSink: TelemetrySink = (event) => {
			recorded.push(event)
		}

		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			telemetrySink: captureSink,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`handler ${name} not registered`)
		return handler
	}

	it('records a tool_call telemetry event for every tool response', async () => {
		const handler = getHandler('list_workspaces')
		await handler({})

		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		expect(toolCalls).toHaveLength(1)
		expect(toolCalls[0].tool_name).toBe('list_workspaces')
		expect(toolCalls[0].has_rich_render).toBe(true)
		expect(typeof toolCalls[0].duration_ms).toBe('number')
		expect(typeof toolCalls[0].session_id).toBe('string')
	})

	it('attaches content/token/structured size fields to tool_call events', async () => {
		const handler = getHandler('list_workspaces')
		await handler({})

		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		expect(toolCalls).toHaveLength(1)
		const call = toolCalls[0]
		// Every formatter-routed handler attaches both surfaces; the wrapper
		// must measure them and record bytes >= 0 and tokens = ceil(bytes/4).
		expect(typeof call.content_bytes).toBe('number')
		expect(call.content_bytes).toBeGreaterThanOrEqual(0)
		expect(typeof call.content_tokens).toBe('number')
		expect(call.content_tokens).toBe(Math.ceil((call.content_bytes ?? 0) / 4))
		expect(typeof call.structured_content_bytes).toBe('number')
		expect(call.structured_content_bytes).toBeGreaterThanOrEqual(0)
	})

	it('reports has_rich_render=true when the tool definition declares _meta.ui', () => {
		// All built-in tools register with _meta.ui; sample a few to assert the
		// signal we read at registration time matches what cards see.
		for (const name of ['create_objects', 'update_objects', 'delete_object', 'list_objects']) {
			const def = definitions.get(name)
			expect(def?._meta?.ui).toBeTruthy()
		}
	})

	it('emits a mutation telemetry event after a successful update_objects call', async () => {
		const handler = getHandler('update_objects')
		await handler({
			workspace_id: wsId,
			updates: [{ id: '11111111-1111-1111-1111-111111111111', status: 'done' }],
		})

		const mutations = recorded.filter((r) => r.event_type === 'mutation')
		expect(mutations).toHaveLength(1)
		expect(mutations[0].tool_name).toBe('update_objects')
		expect(mutations[0].mutation_kind).toBe('update')
		expect(mutations[0].object_type).toBe('object')
	})

	it('does not emit a mutation event for read-only tools', async () => {
		const handler = getHandler('list_objects')
		await handler({ workspace_id: wsId })

		const mutations = recorded.filter((r) => r.event_type === 'mutation')
		expect(mutations).toHaveLength(0)
	})

	it('still records a tool_call event when the underlying handler throws', async () => {
		// Force the API call to fail so the original handler throws.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response('boom', { status: 500 })
		})

		const handler = getHandler('list_workspaces')
		await expect(handler({})).rejects.toThrow()

		// The wrapper records the failed call before re-throwing.
		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		expect(toolCalls).toHaveLength(1)
		expect(toolCalls[0].tool_name).toBe('list_workspaces')
	})

	it('covers every MCP write tool in MUTATION_TOOL_KINDS', async () => {
		// Drift between the MUTATION_TOOL_KINDS table and the registered tool
		// set is the highest-leverage way to undercount the bet's mutation
		// metric. This test pins the contract: every tool whose name implies a
		// mutation (create_*, update_*, delete_*, plus a known set of
		// non-CRUD-named writes) is either listed in MUTATION_TOOL_KINDS or
		// explicitly opted out below.
		const { MUTATION_TOOL_KINDS } = await import('../telemetry')
		const NON_CRUD_WRITE_TOOLS = new Set([
			'add_workspace_member',
			'regenerate_api_key',
			'connect_integration',
			'disconnect_integration',
			'set_llm_api_key',
			'import_claude_subscription',
			'disconnect_claude_subscription',
			'stop_session',
			'pause_session',
			'resume_session',
			'run_agent',
		])
		// Tools whose names start with create_/update_/delete_ but are NOT
		// mutations (e.g. delete_object is — but no such read-only impostors
		// exist today; this list is the documented opt-out hatch).
		const READ_ONLY_PREFIX_EXCEPTIONS = new Set<string>([])

		for (const name of handlers.keys()) {
			const looksLikeWrite =
				name.startsWith('create_') ||
				name.startsWith('update_') ||
				name.startsWith('delete_') ||
				NON_CRUD_WRITE_TOOLS.has(name)

			if (!looksLikeWrite) continue
			if (READ_ONLY_PREFIX_EXCEPTIONS.has(name)) continue

			expect(
				MUTATION_TOOL_KINDS[name],
				`${name} is a write tool but is missing from MUTATION_TOOL_KINDS`,
			).toBeDefined()
		}
	})

	it('does not emit a mutation event when the response shape is unrecognised', async () => {
		// Default fetch stub returns `[]` so update_objects with no updates
		// returns an empty result array. With no entry reporting success: true
		// the wrapper must NOT count the call as a mutation — otherwise the
		// bet metric is biased upward.
		const handler = getHandler('update_objects')
		await handler({ workspace_id: wsId, updates: [] })

		const mutations = recorded.filter((r) => r.event_type === 'mutation')
		expect(mutations).toHaveLength(0)
	})

	it('emits a mutation event after a successful create_objects call', async () => {
		// create_objects overrides structuredContent with the raw graph response
		// ({ nodes, edges }), which the items/single-record branches don't match.
		// The graph branch must catch it — otherwise the most-common write tool's
		// telemetry silently drops to zero.
		const nodeId = '22222222-2222-2222-2222-222222222222'
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response(
				JSON.stringify({
					nodes: [{ id: nodeId, type: 'task', title: 'demo' }],
					edges: [],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			)
		})

		const handler = getHandler('create_objects')
		await handler({
			workspace_id: wsId,
			nodes: [{ type: 'task', title: 'demo' }],
		})

		const mutations = recorded.filter((r) => r.event_type === 'mutation')
		expect(mutations).toHaveLength(1)
		expect(mutations[0].tool_name).toBe('create_objects')
		expect(mutations[0].mutation_kind).toBe('create')
	})
})
