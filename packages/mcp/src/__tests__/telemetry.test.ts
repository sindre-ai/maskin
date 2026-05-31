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
	McpServer: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

const wsId = '00000000-0000-0000-0000-0000000000aa'

describe('MCP telemetry wrapper', () => {
	let recorded: TelemetryEvent[]
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let definitions: Map<string, { _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		recorded = []
		handlers = new Map()
		definitions = new Map()

		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
			definitions.set(
				name as string,
				def as { _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } },
			)
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

	it('reports has_rich_render=true when the tool definition declares a UI resourceUri', () => {
		// All UI-rendering tools register with _meta.ui.resourceUri; sample a
		// few to assert the registration signal still flags them as rich.
		for (const name of ['create_objects', 'update_objects', 'delete_object', 'list_objects']) {
			const def = definitions.get(name)
			expect(def?._meta?.ui?.resourceUri).toBeTruthy()
		}
	})

	it('does not flag visibility-only telemetry tools as rich-render', async () => {
		// `record_widget_event` carries `_meta.ui.visibility: ["app"]` to gate
		// it to widget callers, but it doesn't load a UI resource — its
		// tool_call telemetry must not inflate the rich-render rate.
		const def = definitions.get('record_widget_event')
		expect(def?._meta?.ui?.visibility).toEqual(['app'])
		expect(def?._meta?.ui?.resourceUri).toBeUndefined()

		const handler = getHandler('record_widget_event')
		await handler({
			widget_name: 'hero-card',
			event: 'click_through',
			tool_name: 'get_objects',
			card_kind: 'single',
			object_type: 'bet',
			object_id: 'bet-1',
		})

		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		const widgetCall = toolCalls.find((c) => c.tool_name === 'record_widget_event')
		expect(widgetCall?.has_rich_render).toBe(false)
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
})
