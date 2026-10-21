import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same scaffold as telemetry.test.ts: build the real server wiring with the SDK
// mocked out, then drive the registered (telemetry-wrapped) handlers directly.
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

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { createMcpServer } from '../server'
import type { TelemetryEvent } from '../telemetry'
import { MAX_LISTED_TOOL_ALIASES, TOOL_NAME_ALIASES } from '../tool-aliases'
import { tools } from '../tools'

const wsDefault = '00000000-0000-0000-0000-0000000000aa'
const actorId = '00000000-0000-0000-0000-0000000000bb'
const promptText = 'Summarise the Nakatomi account'

describe('run_agent listed alias of create_session', () => {
	let recorded: TelemetryEvent[]
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let definitions: Map<string, { description?: string; inputSchema?: unknown }>

	beforeEach(() => {
		vi.clearAllMocks()
		recorded = []
		handlers = new Map()
		definitions = new Map()
		vi.mocked(registerAppTool).mockImplementation((_server, name, def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
			definitions.set(name as string, def as { description?: string; inputSchema?: unknown })
		})
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsDefault,
			telemetrySink: (event) => {
				recorded.push(event)
			},
		})
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	// A session that finishes on the first status check, then its logs.
	function mockSessionCompletes() {
		return vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: 'sess-1', status: 'pending' }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ id: 'sess-1', status: 'completed' }),
			} as Response)
			.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) } as Response)
	}

	async function callRunAgent(args: Record<string, unknown>) {
		const handler = handlers.get('run_agent')
		if (!handler) throw new Error('run_agent is not registered')
		const resultPromise = handler(args)
		await vi.advanceTimersByTimeAsync(5000)
		return (await resultPromise) as { content: Array<{ text: string }> }
	}

	const aliasEvents = () =>
		recorded.filter((e): e is Extract<TelemetryEvent, { event_type: 'alias_use' }> => {
			return e.event_type === 'alias_use'
		})

	it('is registered through the wrapper with a one line deprecated description', () => {
		const def = definitions.get('run_agent')
		expect(def).toBeDefined()
		expect(def?.description).toBe('Deprecated, use create_session with wait true.')
		expect(def?.description).not.toContain('\n')
		expect(def?.description).toContain('create_session')
	})

	it('points at a tool that is itself registered', () => {
		expect(handlers.has(TOOL_NAME_ALIASES.run_agent)).toBe(true)
	})

	it('keeps the keys it will drop on the parsed arguments, so their names can be recorded', () => {
		const parsed = tools.run_agent.inputSchema.parse({
			actor_id: actorId,
			action_prompt: promptText,
			config: { runtime: 'codex' },
			timeout_seconds: 120,
		}) as Record<string, unknown>
		expect(Object.keys(parsed)).toEqual(
			expect.arrayContaining(['actor_id', 'action_prompt', 'config', 'timeout_seconds']),
		)
	})

	it('creates a session and returns the shape create_session returns with wait on', async () => {
		vi.useFakeTimers()
		const fetchSpy = mockSessionCompletes()

		const result = await callRunAgent({ actor_id: actorId, action_prompt: promptText })

		const parsed = JSON.parse(result.content[0].text)
		expect(parsed).toMatchObject({ session_id: 'sess-1', settled: true, logs: [] })
		expect(parsed.session).toMatchObject({ id: 'sess-1', status: 'completed' })
		const [create] = fetchSpy.mock.calls[0] as [string, { method: string }]
		expect(create).toBe('http://localhost:3000/api/sessions')
		expect(fetchSpy.mock.calls[0][1]?.method).toBe('POST')
	})

	it('waits by default: it polls the session after creating it', async () => {
		vi.useFakeTimers()
		const fetchSpy = mockSessionCompletes()

		await callRunAgent({ actor_id: actorId, action_prompt: promptText })

		const urls = fetchSpy.mock.calls.map((c) => c[0])
		expect(urls).toContain('http://localhost:3000/api/sessions/sess-1')
		expect(urls).toContain('http://localhost:3000/api/sessions/sess-1/logs?limit=500')
	})

	it('fills the workspace from the connection default when the caller sent none', async () => {
		vi.useFakeTimers()
		const fetchSpy = mockSessionCompletes()

		await callRunAgent({ actor_id: actorId, action_prompt: promptText })

		const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
		expect(headers['X-Workspace-Id']).toBe(wsDefault)
	})

	it('uses the workspace the caller sent over the default', async () => {
		vi.useFakeTimers()
		const other = '00000000-0000-0000-0000-0000000000cc'
		const fetchSpy = mockSessionCompletes()

		await callRunAgent({ workspace_id: other, actor_id: actorId, action_prompt: promptText })

		const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
		expect(headers['X-Workspace-Id']).toBe(other)
	})

	it('carries actor_id, action_prompt and spawned_by_message_id over and sends no dropped key', async () => {
		vi.useFakeTimers()
		const fetchSpy = mockSessionCompletes()

		await callRunAgent({
			actor_id: actorId,
			action_prompt: promptText,
			spawned_by_message_id: 42,
			config: { runtime: 'codex' },
			poll_interval_seconds: 5,
			timeout_seconds: 120,
			depends_on_session_ids: ['00000000-0000-0000-0000-0000000000dd'],
			notify_on_complete: true,
		})

		const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body)
		expect(body).toMatchObject({
			actor_id: actorId,
			action_prompt: promptText,
			spawned_by_message_id: 42,
		})
		for (const dropped of [
			'config',
			'poll_interval_seconds',
			'timeout_seconds',
			'depends_on_session_ids',
		]) {
			expect(body).not.toHaveProperty(dropped)
		}
		expect(body).not.toHaveProperty('wait')
	})

	it('records one alias_use event naming the tool alias and the dropped key names', async () => {
		vi.useFakeTimers()
		mockSessionCompletes()

		await callRunAgent({
			actor_id: actorId,
			action_prompt: promptText,
			config: { runtime: 'codex' },
			timeout_seconds: 120,
		})

		const events = aliasEvents()
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			event_type: 'alias_use',
			tool_name: 'run_agent',
			renames: [],
			both_sent: false,
			dropped_keys: ['config', 'timeout_seconds'],
			tool_alias: { old: 'run_agent', new: 'create_session' },
		})
	})

	it('omits dropped_keys when the caller sent none', async () => {
		vi.useFakeTimers()
		mockSessionCompletes()

		await callRunAgent({ actor_id: actorId, action_prompt: promptText })

		expect(aliasEvents()).toHaveLength(1)
		expect(aliasEvents()[0].dropped_keys).toBeUndefined()
	})

	it('puts no argument value in the event', async () => {
		vi.useFakeTimers()
		mockSessionCompletes()

		await callRunAgent({
			actor_id: actorId,
			action_prompt: promptText,
			config: { runtime: 'codex' },
		})

		const serialised = JSON.stringify(aliasEvents()[0])
		expect(serialised).not.toContain(promptText)
		expect(serialised).not.toContain(actorId)
		expect(serialised).not.toContain('codex')
	})

	it('emits the event before the wait, so a call that never settles is still counted', async () => {
		vi.useFakeTimers()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ id: 'sess-n', status: 'running' }),
		} as Response)

		const handler = handlers.get('run_agent')
		if (!handler) throw new Error('run_agent is not registered')
		const pending = handler({ actor_id: actorId, action_prompt: promptText })
		await vi.advanceTimersByTimeAsync(1000)

		expect(aliasEvents()).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(3_800_000)
		await pending
	})

	it('records one tool_call and one alias_use for a single call, no duplicate', async () => {
		vi.useFakeTimers()
		mockSessionCompletes()

		await callRunAgent({ actor_id: actorId, action_prompt: promptText })

		const runAgentToolCalls = recorded.filter(
			(e) => e.event_type === 'tool_call' && e.tool_name === 'run_agent',
		)
		expect(runAgentToolCalls).toHaveLength(1)
		expect(recorded.filter((e) => e.event_type === 'tool_call')).toHaveLength(1)
		expect(aliasEvents()).toHaveLength(1)
	})
})

describe('tool-name alias cap', () => {
	it(`lists at most ${MAX_LISTED_TOOL_ALIASES} tool-name aliases`, () => {
		expect(Object.keys(TOOL_NAME_ALIASES).length).toBeLessThanOrEqual(MAX_LISTED_TOOL_ALIASES)
	})

	it('has exactly one today: run_agent', () => {
		expect(Object.keys(TOOL_NAME_ALIASES)).toEqual(['run_agent'])
	})

	it('only points at tools that exist', () => {
		for (const target of Object.values(TOOL_NAME_ALIASES)) {
			expect(Object.keys(tools)).toContain(target)
		}
	})

	it('lists every alias in tools with a deprecated one line description naming its target', () => {
		for (const [oldName, target] of Object.entries(TOOL_NAME_ALIASES)) {
			const def = tools[oldName as keyof typeof tools]
			expect(def, `${oldName} is not in tools`).toBeDefined()
			expect(def.description).toMatch(/^Deprecated, use /)
			expect(def.description).toContain(target)
			expect(def.description).not.toContain('\n')
		}
	})
})
