import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent, TelemetrySink } from '../telemetry'

// Hoisted mocks for ext-apps + sdk + node:fs so we can spin up the real
// createMcpServer wiring without any side effects, then drive the registered
// handlers directly to verify the telemetry wrapper.
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

	it('records a tool_call_response_size event with all six properties on every tool response', async () => {
		// AC-T1: the bet's First test. Fires once per tool call, regardless of
		// whether the tool surfaces `structuredContent`. `truncated` is hard-coded
		// false until T4's token-cap wrapper lands.
		const handler = getHandler('search_objects')
		await handler({ workspace_id: wsId, q: 'anything' })

		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		expect(sizeEvents).toHaveLength(1)
		const [evt] = sizeEvents
		if (evt.event_type !== 'tool_call_response_size') throw new Error('narrowing')
		expect(evt.tool_name).toBe('search_objects')
		expect(typeof evt.session_id).toBe('string')
		expect(typeof evt.content_bytes).toBe('number')
		expect(typeof evt.content_tokens).toBe('number')
		expect(typeof evt.structured_content_bytes).toBe('number')
		expect(typeof evt.structured_content_tokens).toBe('number')
		expect(evt.truncated).toBe(false)
		// search_objects always produces both channels, so bytes > 0.
		expect(evt.content_bytes).toBeGreaterThan(0)
		expect(evt.structured_content_bytes).toBeGreaterThan(0)
		// `bytes/4` estimator — match exactly so accidental tokenizer swaps
		// surface in CI rather than silently changing the baseline.
		expect(evt.content_tokens).toBe(Math.ceil(evt.content_bytes / 4))
		expect(evt.structured_content_tokens).toBe(Math.ceil(evt.structured_content_bytes / 4))
	})

	it('reports zero structured_content bytes when the tool omits structuredContent', async () => {
		// list_relationships returns only `content`. Confirms the bet's per-tool
		// p95 ranking won't be polluted by phantom structured bytes.
		const handler = getHandler('list_relationships')
		await handler({ workspace_id: wsId })

		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		expect(sizeEvents).toHaveLength(1)
		const [evt] = sizeEvents
		if (evt.event_type !== 'tool_call_response_size') throw new Error('narrowing')
		expect(evt.structured_content_bytes).toBe(0)
		expect(evt.structured_content_tokens).toBe(0)
		expect(evt.content_bytes).toBeGreaterThan(0)
	})

	it('does not emit a tool_call_response_size event when the underlying handler throws', async () => {
		// On throw the response shape is undefined; we already record the
		// tool_call event (covered above) but skip the size event because there
		// is no payload to measure.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response('boom', { status: 500 })
		})

		const handler = getHandler('list_workspaces')
		await expect(handler({})).rejects.toThrow()

		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		expect(sizeEvents).toHaveLength(0)
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
})
