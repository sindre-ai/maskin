import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK the same way sibling handler tests do so we can capture the
// registered `get_loop` handler and drive it directly against a fake fetch.
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
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	webAppBaseUrl: 'https://maskin.example.com',
	telemetrySink: () => {},
}

// A loop with no step agents assigned + one trigger whose action_prompt
// mentions PostHog (an unconnected provider) — first-test fixture-adjacent, so
// the setup check-set produces multiple concrete findings.
const LOOP_ROW = {
	id: 'loop-1',
	workspaceId: 'ws-default-123',
	name: 'Lead loop',
	status: 'running',
	entryCondition: 'A new lead lands',
	closeCondition: null,
	triggerIds: ['trig-a', 'trig-b'],
	agentIds: [],
	inProgressCount: 0,
	closedCount: 0,
	pill: 'running',
}

const TRIGGER_ROWS = [
	{
		id: 'trig-a',
		name: 'Qualify',
		targetActorId: 'agent-a',
		actionPrompt: 'Pull recent posthog events and qualify.',
		config: { cron: '0 9 * * *' },
	},
	{
		id: 'trig-b',
		name: 'Capture',
		targetActorId: null,
		actionPrompt: 'Capture learnings.',
		config: {},
	},
]

const ACTOR_ROWS = [
	{ id: 'agent-a', name: 'Qualifier', systemPrompt: 'You qualify inbound leads.' },
]

describe("get_loop `include: ['setup']`", () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	function stubHappyPath() {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const u = String(url)
			if (u.includes('/api/loops?id=loop-1')) {
				return { ok: true, json: () => Promise.resolve({ loops: [LOOP_ROW] }) } as Response
			}
			if (u.includes('/api/workspaces')) {
				return {
					ok: true,
					json: () => Promise.resolve([{ id: 'ws-default-123', name: 'Test WS', settings: {} }]),
				} as Response
			}
			if (u.includes('/api/integrations')) {
				return { ok: true, json: () => Promise.resolve([]) } as Response
			}
			if (u.includes('/api/triggers')) {
				return { ok: true, json: () => Promise.resolve(TRIGGER_ROWS) } as Response
			}
			if (u.includes('/api/actors')) {
				return { ok: true, json: () => Promise.resolve(ACTOR_ROWS) } as Response
			}
			throw new Error(`Unexpected fetch: ${u}`)
		})
	}

	it('accepts `setup` at the schema layer and rejects any other include value', () => {
		const ok = tools.get_loop.inputSchema.safeParse({
			id: '00000000-0000-0000-0000-000000000001',
			include: ['setup'],
		})
		expect(ok.success).toBe(true)

		const bad = tools.get_loop.inputSchema.safeParse({
			id: '00000000-0000-0000-0000-000000000001',
			include: ['bogus'],
		})
		expect(bad.success).toBe(false)
	})

	it('omits the setup block when include is empty, but still nests steps (existing response shape)', async () => {
		stubHappyPath()

		const handler = getHandler('get_loop')
		const result = (await handler({ id: 'loop-1' })) as { content: Array<{ text: string }> }
		const parsed = JSON.parse(result.content[0].text)

		expect(parsed.loop.id).toBe('loop-1')
		expect(parsed.setup).toBeUndefined()

		// `steps` mirrors what create_loop/update_loop return by default: each
		// trigger nested with its resolved agent, in trigger_ids order.
		const steps = parsed.steps as Array<{
			triggerId: string
			agent: { id: string; name: string } | null
		}>
		expect(steps).toHaveLength(2)
		expect(steps[0].triggerId).toBe('trig-a')
		expect(steps[0].agent?.id).toBe('agent-a')
		expect(steps[1].triggerId).toBe('trig-b')
		expect(steps[1].agent).toBeNull()
	})

	it('attaches a fresh setup block when include contains `setup`', async () => {
		stubHappyPath()

		const handler = getHandler('get_loop')
		const result = (await handler({ id: 'loop-1', include: ['setup'] })) as {
			content: Array<{ text: string }>
		}
		const parsed = JSON.parse(result.content[0].text)

		expect(parsed.loop.id).toBe('loop-1')
		expect(parsed.setup).toBeDefined()
		const setup = parsed.setup as {
			checks: Array<{ name: string; status: string; fix?: { tool: string } }>
			next_steps: Array<{ name: string }>
			prose: string
		}
		expect(Array.isArray(setup.checks)).toBe(true)
		expect(setup.checks.length).toBeGreaterThan(0)
		// The fixture has an agent-less step, an unconnected posthog reference,
		// no close condition, no members, and no workspace LLM key — every
		// concrete loop check should have fired.
		const names = setup.checks.map((c) => c.name)
		expect(names).toContain('steps_have_agents')
		expect(names).toContain('agents_runnable')
		expect(names).toContain('connectors_connected')
		expect(names).toContain('conditions_set')
		expect(names).toContain('has_members')

		// The connector fix hint must name PostHog and the tool to call.
		const connector = setup.checks.find((c) => c.name === 'connectors_connected')
		expect(connector?.fix?.tool).toBe('connect_integration')

		// next_steps is the top-3 slice, prose is the "Ask the user…" render.
		expect(setup.next_steps.length).toBeLessThanOrEqual(3)
		expect(setup.prose).toContain('Ask the user')
	})

	it('degrades the setup block to a single unknown check when context fetch fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const u = String(url)
			if (u.includes('/api/loops?id=loop-1')) {
				return { ok: true, json: () => Promise.resolve({ loops: [LOOP_ROW] }) } as Response
			}
			// Every downstream call fails — the primary loop response must still
			// come back, with the setup block collapsing to a single unknown.
			return { ok: false, status: 500, text: () => Promise.resolve('boom') } as Response
		})

		const handler = getHandler('get_loop')
		const result = (await handler({ id: 'loop-1', include: ['setup'] })) as {
			content: Array<{ text: string }>
		}
		const parsed = JSON.parse(result.content[0].text)

		expect(parsed.loop.id).toBe('loop-1')
		expect(parsed.setup).toBeDefined()
		const setup = parsed.setup as {
			checks: Array<{ name: string; status: string }>
			next_steps: unknown[]
			prose: string
		}
		expect(setup.checks).toHaveLength(1)
		expect(setup.checks[0].status).toBe('unknown')
		expect(setup.next_steps).toEqual([])
		expect(setup.prose).toBe('')
	})
})
