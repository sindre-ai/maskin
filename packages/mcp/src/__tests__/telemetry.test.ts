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

	it('still records a tool_call event when a mutation handler throws', async () => {
		// Force the API call to fail so the original handler throws.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response('boom', { status: 500 })
		})

		// Mutation tools intentionally re-throw so upstream telemetry stays intact;
		// read-side handlers convert failures into a structured `{ error: {...} }`
		// response (T2) — that path is covered by the size-event test below.
		const handler = getHandler('delete_object')
		await expect(
			handler({ workspace_id: wsId, id: '00000000-0000-0000-0000-0000000000cc' }),
		).rejects.toThrow()

		// The wrapper records the failed call before re-throwing.
		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		expect(toolCalls).toHaveLength(1)
		expect(toolCalls[0].tool_name).toBe('delete_object')
	})

	it('records a tool_call_response_size event when a read handler surfaces a structured error (T2)', async () => {
		// Read-side handlers return `{ isError: true, structuredContent: { error: {...} } }`
		// instead of throwing, so the size event still fires and captures the
		// error envelope's byte cost.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response('boom', { status: 500 })
		})

		const handler = getHandler('list_workspaces')
		const result = (await handler({})) as {
			isError?: boolean
			structuredContent?: { error?: { tool: string } }
		}
		expect(result.isError).toBe(true)
		expect(result.structuredContent?.error?.tool).toBe('list_workspaces')

		const toolCalls = recorded.filter((r) => r.event_type === 'tool_call')
		expect(toolCalls).toHaveLength(1)
		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		expect(sizeEvents).toHaveLength(1)
		const [evt] = sizeEvents
		if (evt.event_type !== 'tool_call_response_size') throw new Error('narrowing')
		expect(evt.tool_name).toBe('list_workspaces')
		expect(evt.truncated).toBe(false)
		expect(evt.content_bytes).toBeGreaterThan(0)
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
			'connect_integration',
			'disconnect_integration',
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
		// delete_relationship returns only `content`. Confirms the bet's per-tool
		// p95 ranking won't be polluted by phantom structured bytes.
		const handler = getHandler('delete_relationship')
		await handler({ workspace_id: wsId, id: '00000000-0000-0000-0000-0000000000bb' })

		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		expect(sizeEvents).toHaveLength(1)
		const [evt] = sizeEvents
		if (evt.event_type !== 'tool_call_response_size') throw new Error('narrowing')
		expect(evt.structured_content_bytes).toBe(0)
		expect(evt.structured_content_tokens).toBe(0)
		expect(evt.content_bytes).toBeGreaterThan(0)
	})

	it('does not emit a tool_call_response_size event when a mutation handler throws', async () => {
		// On throw the response shape is undefined; we already record the
		// tool_call event (covered above) but skip the size event because there
		// is no payload to measure. Read-side handlers instead return a
		// structured error and DO emit a size event — see the T2 test above.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response('boom', { status: 500 })
		})

		const handler = getHandler('delete_object')
		await expect(
			handler({ workspace_id: wsId, id: '00000000-0000-0000-0000-0000000000dd' }),
		).rejects.toThrow()

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

// The env branch that resolves a container-launched server's session id used to
// read `MASKIN_SESSION_ID`, which nothing in the repo ever sets — so it was
// dead, and every stdio server in an agent container fell through to a random
// id that cannot join back to the `sessions` row. These pin the var names.
describe('session id resolution', () => {
	const ORIGINAL = { ...process.env }

	afterEach(() => {
		process.env = { ...ORIGINAL }
		vi.resetModules()
	})

	/** Replace the env with both session vars cleared, then apply `vars`. */
	function setEnv(vars: Record<string, string>) {
		const { SESSION_ID: _a, MASKIN_SESSION_ID: _b, ...rest } = ORIGINAL
		process.env = { ...rest, ...vars }
	}

	async function loadFresh() {
		vi.resetModules()
		return await import('../telemetry')
	}

	it('uses SESSION_ID — the var the agent container actually sets', async () => {
		setEnv({ SESSION_ID: '33333333-3333-4333-8333-333333333333' })
		const mod = await loadFresh()
		expect(mod.__sessionId()).toBe('33333333-3333-4333-8333-333333333333')
		expect(mod.__sessionSource()).toBe('maskin-session')
	})

	it('lets MASKIN_SESSION_ID override, for a host that uses SESSION_ID itself', async () => {
		setEnv({ SESSION_ID: 'host-owned', MASKIN_SESSION_ID: 'maskin-owned' })
		const mod = await loadFresh()
		expect(mod.__sessionId()).toBe('maskin-owned')
		expect(mod.__sessionSource()).toBe('maskin-session')
	})

	it('falls back to a per-process id, flagged as such, outside a container', async () => {
		setEnv({})
		const mod = await loadFresh()
		expect(mod.__sessionId()).toMatch(/^mcp-/)
		// Must not claim `maskin-session`: nothing here joins to a sessions row.
		expect(mod.__sessionSource()).toBe('process')
	})

	it('ignores a blank SESSION_ID rather than grouping on an empty id', async () => {
		setEnv({ SESSION_ID: '   ' })
		const mod = await loadFresh()
		expect(mod.__sessionId()).toMatch(/^mcp-/)
		expect(mod.__sessionSource()).toBe('process')
	})
})

describe('recordToolCallResponseSize — shape fields', () => {
	// `vi.resetModules()` above means a statically imported telemetry module
	// would be a different instance from the one the server tests drive, and
	// the per-process seq counter lives in module state. Import per test.
	const TARGET = { apiBaseUrl: 'http://localhost:3000', apiKey: 'ank_testkey', workspaceId: wsId }

	type SizeEvent = Extract<TelemetryEvent, { event_type: 'tool_call_response_size' }>

	async function load() {
		vi.resetModules()
		const mod = await import('../telemetry')
		mod.__resetToolCallSeq()
		const events: TelemetryEvent[] = []
		const sink: TelemetrySink = (e) => events.push(e)
		const size = (event: Omit<Parameters<typeof mod.recordToolCallResponseSize>[2], never>) => {
			mod.recordToolCallResponseSize(sink, TARGET, event)
			return events[events.length - 1] as SizeEvent
		}
		return { mod, sink, events, size }
	}

	it('carries the row count and heaviest field alongside the byte totals', async () => {
		const { size } = await load()
		const event = size({
			tool_name: 'list_objects',
			content: [{ type: 'text', text: 'ok' }],
			structured_content: {
				objects: [
					{ id: 'a', content: 'x'.repeat(300) },
					{ id: 'b', content: 'y'.repeat(300) },
				],
			},
			truncated: false,
		})
		expect(event.row_count).toBe(2)
		expect(event.top_fields?.[0]).toBe('content')
		expect(event.content_block_count).toBe(1)
		expect(event.max_row_bytes).toBeGreaterThan(300)
	})

	it('omits shape fields rather than sending null when they do not apply', async () => {
		// The ingest schema types these as optional numbers. A null would fail
		// validation and cost the whole event, byte totals included.
		const { size } = await load()
		const event = size({
			tool_name: 'get_objects',
			content: undefined,
			structured_content: { id: 'a' },
			truncated: false,
		})
		expect(event.row_count).toBeUndefined()
		expect(event.max_row_bytes).toBeUndefined()
		expect(event.content_block_count).toBeUndefined()
	})

	it('reads the shared seq without advancing it', async () => {
		// Both events for one call must report the same position. Incrementing
		// here as well would double every call's seq and break the join.
		const { mod, sink, size } = await load()
		mod.recordToolCall(sink, TARGET, {
			tool_name: 'list_objects',
			has_rich_render: false,
			duration_ms: 1,
		})
		const args = {
			tool_name: 'list_objects',
			content: undefined,
			structured_content: undefined,
			truncated: false,
		}
		const first = size({ ...args, seq: mod.currentToolCallSeq() })
		const second = size({ ...args, seq: mod.currentToolCallSeq() })
		expect(first.seq).toBe(1)
		expect(second.seq).toBe(1)
	})

	it('records argument key names so a broad call is distinguishable from a narrow one', async () => {
		const { size } = await load()
		const event = size({
			tool_name: 'list_objects',
			content: undefined,
			structured_content: undefined,
			truncated: false,
			args: { limit: 100, type: 'insight' },
		})
		expect(event.arg_keys).toEqual(['limit', 'type'])
	})

	it('never lets a response value reach the event', async () => {
		const { size } = await load()
		const event = size({
			tool_name: 'list_objects',
			content: [{ type: 'text', text: 'Acquire the Nakatomi account' }],
			structured_content: { objects: [{ id: 'a', title: 'Acquire the Nakatomi account' }] },
			truncated: false,
			args: { query: 'Acquire the Nakatomi account' },
		})
		expect(JSON.stringify(event)).not.toContain('Nakatomi')
	})
})

// `recordMutation` used to stamp the module-scope SESSION_ID while
// `recordToolCall` had been moved onto the per-target override. On the HTTP
// transport that constant is the apps/dev PROCESS's id, so one call's two
// events landed under two different session ids — and the summary query groups
// by `session_id` with `HAVING bool_or(event_type = 'tool_call')`, which drops
// the mutation-only group and reports `mutation_session_pct` as 0 for every
// containerised agent. These pin both emitters to the same identity.
describe('recordMutation — session identity', () => {
	const BASE = { apiBaseUrl: 'http://localhost:3000', apiKey: 'ank_testkey', workspaceId: wsId }

	async function load() {
		vi.resetModules()
		const mod = await import('../telemetry')
		const events: TelemetryEvent[] = []
		const sink: TelemetrySink = (e) => events.push(e)
		return { mod, sink, events }
	}

	it('uses the host-supplied session id, not the process id', async () => {
		const { mod, sink, events } = await load()
		const target = { ...BASE, sessionId: 'sess-http-1', sessionSource: 'maskin-session' as const }
		mod.recordMutation(sink, target, { tool_name: 'update_objects', mutation_kind: 'update' })
		expect(events[0]).toMatchObject({ event_type: 'mutation', session_id: 'sess-http-1' })
	})

	it('stamps the same session id as the tool_call for the same call', async () => {
		const { mod, sink, events } = await load()
		const target = { ...BASE, sessionId: 'sess-http-2', sessionSource: 'maskin-session' as const }
		mod.recordToolCall(sink, target, {
			tool_name: 'update_objects',
			has_rich_render: false,
			duration_ms: 5,
			transport: 'http',
		})
		mod.recordMutation(sink, target, { tool_name: 'update_objects', mutation_kind: 'update' })
		const [toolCall, mutation] = events
		// The join the summary query depends on. If these diverge,
		// `mutation_session_pct` silently reads 0 for all HTTP traffic.
		expect(mutation.session_id).toBe(toolCall.session_id)
		expect(mutation.session_id).toBe('sess-http-2')
	})

	it('falls back to the process id on stdio, where no override is supplied', async () => {
		const { mod, sink, events } = await load()
		mod.recordMutation(sink, BASE, { tool_name: 'create_objects', mutation_kind: 'create' })
		expect(events[0].session_id).toBe(mod.__sessionId())
	})
})
