import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mocking envelope used by response-scoping.test.ts and response-cap.test.ts —
// stubs the SDK + ext-apps + node:fs so `createMcpServer` wires up without side
// effects and every registered handler is captured in a Map for direct call.
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
import {
	DEFAULT_MAX_RESPONSE_TOKENS,
	RESPONSE_TOKEN_CAP_ENV_VAR,
	estimateResponseTokens,
} from '../response-cap'
import { createMcpServer } from '../server'

const wsId = '00000000-0000-0000-0000-0000000000aa'

type Handler = (args: Record<string, unknown>) => Promise<unknown>

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: wsId,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

// ─── Row factories ─────────────────────────────────────────────────
// Sizes are picked so a 25-row scoped page is representative of what a
// production workspace actually returns — not toy fixtures — so the p95
// harness (AC-T7) exercises the token-cap arithmetic realistically.

function objectRow(idx: number) {
	return {
		id: `00000000-0000-0000-0000-${String(idx).padStart(12, '0')}`,
		type: idx % 3 === 0 ? 'bet' : idx % 3 === 1 ? 'task' : 'insight',
		title: `Object ${idx} — descriptive title so summary rows have realistic byte count`,
		status: idx % 2 === 0 ? 'active' : 'done',
		driver: null,
		content: 'x'.repeat(600) + `\nParagraph two of the object content for row ${idx}.\n`.repeat(3),
		metadata: {
			parent_bet: `00000000-0000-0000-0000-${String(idx + 999).padStart(12, '0')}`,
			tags: ['anchor:3', 'source:slack', 'evidence:high', 'promotion:auto'],
			posthog_query: `event=mcp_tool_call_response_size properties.tool_name=list_${idx}`,
		},
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-06-01T00:00:00.000Z',
	}
}

function actorRow(idx: number) {
	return {
		id: `10000000-0000-0000-0000-${String(idx).padStart(12, '0')}`,
		type: idx % 2 === 0 ? 'agent' : 'human',
		name: `Actor ${idx} full descriptive display name`,
		email: `actor-${idx}@example.com`,
		role: idx % 3 === 0 ? 'owner' : 'member',
		description: `Short one-line summary for actor ${idx} that stays under 80 chars.`,
		system_prompt:
			'y'.repeat(1800) + `\nAdditional context describing actor ${idx}'s role.\n`.repeat(2),
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-06-01T00:00:00.000Z',
	}
}

function relationshipRow(idx: number) {
	return {
		id: `20000000-0000-0000-0000-${String(idx).padStart(12, '0')}`,
		sourceId: `00000000-0000-0000-0000-${String(idx * 2).padStart(12, '0')}`,
		targetId: `00000000-0000-0000-0000-${String(idx * 2 + 1).padStart(12, '0')}`,
		type: idx % 4 === 0 ? 'breaks_into' : idx % 4 === 1 ? 'informs' : 'relates_to',
		sourceTitle: `Source object ${idx} with a fairly descriptive title`,
		targetTitle: `Target object ${idx} with a fairly descriptive title`,
		createdAt: '2026-01-01T00:00:00.000Z',
	}
}

function triggerRow(idx: number) {
	return {
		id: `30000000-0000-0000-0000-${String(idx).padStart(12, '0')}`,
		name: `Trigger ${idx} descriptive name for legibility`,
		type: idx % 2 === 0 ? 'cron' : 'event',
		config: {
			expression: '*/5 * * * *',
			target: `object-${idx}`,
			payload: 'p'.repeat(200),
		},
		enabled: idx % 3 !== 0,
		targetActorId: null,
		workspaceId: wsId,
		actionPrompt: 'a'.repeat(400),
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-06-01T00:00:00.000Z',
	}
}

function fileRow(idx: number) {
	return {
		id: `40000000-0000-0000-0000-${String(idx).padStart(12, '0')}`,
		workspaceId: wsId,
		name: `file-${idx}-with-a-fairly-descriptive-name.pdf`,
		description: 'd'.repeat(300),
		mimeType: 'application/pdf',
		sizeBytes: 12_345 + idx,
		storageKey: `wf/${idx}/`.padEnd(120, 'k'),
		createdBy: '10000000-0000-0000-0000-000000000001',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function skillRow(idx: number) {
	return {
		id: `50000000-0000-0000-0000-${String(idx).padStart(12, '0')}`,
		workspaceId: wsId,
		name: `skill-${idx}-with-a-descriptive-slug`,
		description: `Line one of skill ${idx} description.\nLine two with additional context.`,
		storageKey: `wskills/${idx}/`.padEnd(140, 'k'),
		sizeBytes: 6543 + idx,
		isValid: true,
		createdBy: '10000000-0000-0000-0000-000000000001',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

// Fetch stub — replies with the given fixture for the main API path and
// returns an empty list for the actor id-lookup helper (used by list_triggers
// to resolve target actor names).
function stubFetch(fixture: unknown[]) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const urlStr = String(url)
		if (urlStr.includes('/api/actors?ids=')) {
			return { ok: true, json: () => Promise.resolve([]) } as Response
		}
		return {
			ok: true,
			headers: new Headers(),
			json: () => Promise.resolve(fixture),
		} as Response
	})
}

function setupServer(): Map<string, Handler> {
	const handlers = new Map<string, Handler>()
	vi.mocked(McpServer).mockImplementation(
		() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
	)
	vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
		handlers.set(name as string, handler as Handler)
	})
	createMcpServer(config)
	return handlers
}

// ─────────────────────────────────────────────────────────────────
// AC-U3 — contract replay
// ─────────────────────────────────────────────────────────────────
//
// The AC calls for recorded traces from a real Claude Code client + workspace
// agent replayed against the new server. A stubbed unit test can't capture
// real network traffic, so this suite substitutes a hand-picked corpus of
// request shapes that mirror what those clients actually send — the
// no-params list read, the filtered list, the search query, the
// object-anchored relationship walk, and so on. The invariant is that every
// trace responds without error and `content[0].text` parses as JSON.

describe('AC-U3 verification harness — contract replay of typical Claude Code + workspace-agent traces', () => {
	let handlers: Map<string, Handler>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = setupServer()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		delete process.env[RESPONSE_TOKEN_CAP_ENV_VAR]
	})

	// Each trace: the tool the client called, the args it passed, and a
	// fixture the API would have returned. Chosen to cover the shapes the two
	// callers actually use in production: Claude Code sessions and background
	// workspace agents that page through workspace state.
	//
	// `list_actors` is intentionally absent — it has no `content` channel
	// (structuredContent-only), so it can't participate in a content-channel
	// parity loop. See the dedicated trace test below.
	const traces: Array<{
		trace: string
		tool: string
		args: Record<string, unknown>
		fixture: unknown[]
	}> = [
		{
			trace: 'claude-code: list_objects (no filter, default page)',
			tool: 'list_objects',
			args: {},
			fixture: [objectRow(1), objectRow(2), objectRow(3)],
		},
		{
			trace: 'claude-code: search_objects (typical query)',
			tool: 'search_objects',
			args: { q: 'response scoping' },
			fixture: [objectRow(10)],
		},
		{
			trace: 'workspace-agent: list_objects (filter by type=bet)',
			tool: 'list_objects',
			args: { type: 'bet' },
			fixture: [objectRow(1)],
		},
		{
			trace: 'workspace-agent: list_relationships (anchored on object_id)',
			tool: 'list_relationships',
			args: { object_id: '00000000-0000-0000-0000-000000000001' },
			fixture: [relationshipRow(1), relationshipRow(2)],
		},
		{
			trace: 'workspace-agent: list_triggers (default)',
			tool: 'list_triggers',
			args: {},
			fixture: [triggerRow(1), triggerRow(2)],
		},
		{
			trace: 'workspace-agent: list_files (default)',
			tool: 'list_files',
			args: {},
			fixture: [fileRow(1), fileRow(2)],
		},
		{
			trace: 'workspace-agent: list_workspace_skills (default)',
			tool: 'list_workspace_skills',
			args: {},
			fixture: [skillRow(1), skillRow(2)],
		},
	]

	for (const { trace, tool, args, fixture } of traces) {
		it(`${trace}: responds without error and without breaking the content channel`, async () => {
			stubFetch(fixture)
			const handler = handlers.get(tool)
			if (!handler) throw new Error(`handler ${tool} not registered`)
			const result = (await handler(args)) as {
				content: Array<{ text: string }>
				structuredContent?: Record<string, unknown>
			}
			// Content is the full JSON payload (the lean markdown-summary channel
			// was reverted — it left agents without enough detail to act on).
			// Structured channel, when present, is a real object (never a string).
			expect(result.content).toBeDefined()
			expect(result.content[0].text.length).toBeGreaterThan(0)
			expect(() => JSON.parse(result.content[0].text)).not.toThrow()
			if (result.structuredContent) {
				expect(typeof result.structuredContent).toBe('object')
				expect(Array.isArray(result.structuredContent)).toBe(false)
			}
		})
	}

	it('claude-code: list_actors (default): responds via structuredContent only', async () => {
		const fixture = [actorRow(1), actorRow(2)]
		stubFetch(fixture)
		const handler = handlers.get('list_actors')
		if (!handler) throw new Error('handler list_actors not registered')
		const result = (await handler({})) as {
			content?: Array<{ text: string }>
			structuredContent: { heroCard: { kind: string; objects?: unknown[] } }
		}
		expect(result.content).toBeUndefined()
		expect(result.structuredContent.heroCard.kind).toBe('list')
		expect(result.structuredContent.heroCard.objects).toHaveLength(fixture.length)
	})
})

// ─────────────────────────────────────────────────────────────────
// Repeated-call determinism
// ─────────────────────────────────────────────────────────────────
//
// Pagination and the token cap are always on now (no flag to toggle), so the
// invariant this suite checks is simpler than it used to be: calling the
// same handler twice against the same fixture produces byte-identical
// output — no process-level state (snapshot timestamps, cursor state, trim
// bookkeeping) leaks between calls.

describe('verification harness — repeated calls against the same fixture are deterministic', () => {
	let handlers: Map<string, Handler>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = setupServer()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		delete process.env[RESPONSE_TOKEN_CAP_ENV_VAR]
	})

	const cases: Array<{
		tool: string
		args?: Record<string, unknown>
		fixture: unknown[]
	}> = [
		{ tool: 'list_objects', fixture: [objectRow(1), objectRow(2)] },
		{ tool: 'search_objects', args: { q: 'anything' }, fixture: [objectRow(3), objectRow(4)] },
		{
			tool: 'list_relationships',
			fixture: [relationshipRow(1), relationshipRow(2)],
		},
		{ tool: 'list_triggers', fixture: [triggerRow(1), triggerRow(2)] },
		{ tool: 'list_files', fixture: [fileRow(1), fileRow(2)] },
		{
			tool: 'list_workspace_skills',
			fixture: [skillRow(1), skillRow(2)],
		},
	]

	for (const { tool, args, fixture } of cases) {
		it(`${tool}: two calls against the same fixture return byte-identical content`, async () => {
			stubFetch(fixture)
			const handler = handlers.get(tool)
			if (!handler) throw new Error(`handler ${tool} not registered`)

			const first = (await handler(args ?? {})) as {
				content: Array<{ text: string }>
				structuredContent?: Record<string, unknown>
			}
			expect(() => JSON.parse(first.content[0].text)).not.toThrow()

			const second = (await handler(args ?? {})) as {
				content: Array<{ text: string }>
				structuredContent?: Record<string, unknown>
			}
			expect(second.content[0].text).toBe(first.content[0].text)
			expect(Boolean(second.structuredContent)).toBe(Boolean(first.structuredContent))
		})
	}

	it('list_actors: two calls against the same fixture return an identical structuredContent-only shape', async () => {
		const fixture = [actorRow(1), actorRow(2)]
		stubFetch(fixture)
		const handler = handlers.get('list_actors')
		if (!handler) throw new Error('handler list_actors not registered')

		const first = (await handler({})) as { content?: unknown; structuredContent: unknown }
		expect(first.content).toBeUndefined()

		const second = (await handler({})) as { content?: unknown; structuredContent: unknown }
		expect(second.content).toBeUndefined()
		expect(second.structuredContent).toEqual(first.structuredContent)
	})

	it('list_objects: token-cap truncation markers reappear consistently across repeated calls', async () => {
		// Bigger fixture (30 rows, well past the default 25-row page) + lower cap
		// so the wrapper's fetch_handle metadata is forced onto the response.
		const fixture = Array.from({ length: 30 }, (_, i) => objectRow(i))
		stubFetch(fixture)
		const handler = handlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')
		process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '2000'

		const first = (await handler({})) as {
			_meta: { truncated?: boolean; fetch_handle?: { tool: string; ids: string[] } }
			structuredContent: { next_cursor?: string }
		}
		expect(first._meta.truncated).toBe(true)
		expect(first._meta.fetch_handle?.tool).toBe('get_objects')
		expect(typeof first.structuredContent.next_cursor).toBe('string')

		const second = (await handler({})) as {
			_meta: { truncated?: boolean; fetch_handle?: { tool: string; ids: string[] } }
			structuredContent: { next_cursor?: string }
		}
		expect(second._meta.truncated).toBe(true)
		expect(second._meta.fetch_handle?.tool).toBe('get_objects')
		expect(second._meta.fetch_handle?.ids).toEqual(first._meta.fetch_handle?.ids)
		expect(typeof second.structuredContent.next_cursor).toBe('string')
	})
})

// ─────────────────────────────────────────────────────────────────
// AC-T7 — seeded p95 fixture cap
// ─────────────────────────────────────────────────────────────────
//
// Seeds a fixture at the T5 brief's p95 estimates (real numbers land after
// T1's 5-day telemetry window). Calls every read tool with default params
// under scoping and asserts the shipped response stays under
// `MAX_RESPONSE_TOKENS` (15K default). Row bodies carry realistic content,
// metadata, and long-form fields so the assertion isn't undermined by
// featherweight test data.

describe('AC-T7 verification harness — seeded p95 fixture never busts the 15K per-response cap', () => {
	let handlers: Map<string, Handler>

	// Per the T5 brief — hold-over generous estimates until real p95 numbers
	// land from T1's telemetry window. Kept as a table so the "the p95 number
	// changed" follow-up is a one-line edit.
	const P95: Record<string, number> = {
		objects: 1000,
		actors: 500,
		relationships: 5000,
		triggers: 200,
		files: 300,
		skills: 30,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = setupServer()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		delete process.env[RESPONSE_TOKEN_CAP_ENV_VAR]
	})

	const cases: Array<{
		tool: string
		args?: Record<string, unknown>
		fixture: unknown[]
	}> = [
		{
			tool: 'list_objects',
			fixture: Array.from({ length: P95.objects }, (_, i) => objectRow(i)),
		},
		{
			tool: 'search_objects',
			args: { q: 'anything' },
			fixture: Array.from({ length: P95.objects }, (_, i) => objectRow(i)),
		},
		{
			tool: 'list_actors',
			fixture: Array.from({ length: P95.actors }, (_, i) => actorRow(i)),
		},
		{
			tool: 'list_relationships',
			fixture: Array.from({ length: P95.relationships }, (_, i) => relationshipRow(i)),
		},
		{
			tool: 'list_triggers',
			fixture: Array.from({ length: P95.triggers }, (_, i) => triggerRow(i)),
		},
		{
			tool: 'list_files',
			fixture: Array.from({ length: P95.files }, (_, i) => fileRow(i)),
		},
		{
			tool: 'list_workspace_skills',
			fixture: Array.from({ length: P95.skills }, (_, i) => skillRow(i)),
		},
	]

	for (const { tool, args, fixture } of cases) {
		it(`${tool}: default-params response stays under MAX_RESPONSE_TOKENS on a p95-seeded workspace`, async () => {
			stubFetch(fixture)
			const handler = handlers.get(tool)
			if (!handler) throw new Error(`handler ${tool} not registered`)
			const result = await handler(args ?? {})
			expect(estimateResponseTokens(result)).toBeLessThanOrEqual(DEFAULT_MAX_RESPONSE_TOKENS)
		})
	}

	it('honours a lowered MCP_RESPONSE_MAX_TOKENS override (still holds under the tighter cap)', async () => {
		// If a deployment tightens the cap, the same seeded fixture must still
		// squeeze under it — the wrapper needs to trim, not overshoot.
		process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '5000'
		const fixture = Array.from({ length: P95.objects }, (_, i) => objectRow(i))
		stubFetch(fixture)
		const handler = handlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')
		const result = await handler({})
		expect(estimateResponseTokens(result)).toBeLessThanOrEqual(5000)
	})
})

// ─────────────────────────────────────────────────────────────────
// Content channel parity — no lean-summary regression
// ─────────────────────────────────────────────────────────────────
//
// An earlier iteration of list/search tools swapped the `content` channel
// for a lean markdown summary (one line per row, full payload only on
// `structuredContent`) behind a flag. That left agents without enough
// detail in `content` to act on, so it was reverted: `content` is always
// the full JSON payload. This test anchors that so a future regression that
// reintroduces the lean summary fails loudly here.

describe('Content channel parity — content is always the full JSON dump, never a lean summary', () => {
	let handlers: Map<string, Handler>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = setupServer()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('list_objects: content is the full JSON dump, not a lean per-row summary', async () => {
		const fixture = Array.from({ length: 5 }, (_, i) => objectRow(i))
		stubFetch(fixture)
		const handler = handlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')

		const result = (await handler({})) as {
			content: Array<{ text: string }>
			structuredContent: { objects: unknown[] }
		}
		const contentBytes = Buffer.byteLength(result.content[0].text, 'utf8')
		// Compare against just `structuredContent.objects` — the same rows
		// `content` carries — not the whole `structuredContent` object, which
		// also carries a duplicated heroCard slice and page metadata and would
		// unfairly inflate the baseline.
		const objectsBytes = Buffer.byteLength(JSON.stringify(result.structuredContent.objects), 'utf8')

		expect(contentBytes).toBeGreaterThan(0)
		expect(() => JSON.parse(result.content[0].text)).not.toThrow()
		// A lean per-row summary would be a small fraction of the row data's
		// size; the full JSON dump is the same data, so it should match closely.
		expect(contentBytes).toBeGreaterThanOrEqual(objectsBytes * 0.9)
	})
})
