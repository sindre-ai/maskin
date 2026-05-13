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

		// The wrapper records the failed call before re-throwing. `list_workspaces`
		// declares `_meta.ui` on its definition, so the documented failure-path
		// interpretation ("definition advertises rich render") yields `true`.
		// Guards the intentional choice from task 146553f7.
		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		expect(toolCalls).toHaveLength(1)
		expect(toolCalls[0].tool_name).toBe('list_workspaces')
		expect(toolCalls[0].has_rich_render).toBe(true)
	})
})
