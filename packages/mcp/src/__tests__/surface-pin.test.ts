import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mock scaffold as telemetry.test.ts — spin up createMcpServer without
// side effects so the registered tool set is the ground truth.
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

// Verb-prefix pattern for MCP-style tool identifiers. Matches things like
// `get_session_logs`, `create_notification`, `update_objects` — the shape of a
// tool name — without swallowing field names like `workspace_id` or `in_loop`.
const TOOL_TOKEN_RE =
	/\b(get|list|search|create|update|delete|run|regenerate|set|import|disconnect|rename|record|traverse|mark|pause|resume|stop|connect)_[a-z][a-z_]*\b/g

// Snake_case tokens that match the verb-prefix shape but are field / arg /
// enum names, not tool references. Kept small on purpose — grow it only when
// a new false positive appears.
const NON_TOOL_TOKENS = new Set<string>(['create_relationship', 'delete_relationship'])
// Note: delete_relationship IS registered, so it wouldn't fail the check
// anyway — but listing it here documents that the intent when it appears in
// prose is often "the relationship-delete concept," not a tool call.

// READ_TOOL_NAMES as it stood before the annotations PR. It also decides whether a
// thrown handler error becomes an error envelope or is re-thrown, so annotations
// must neither edit it nor be derived from it. Pinned in order, name by name.
const EXPECTED_READ_TOOL_NAMES = [
	'get_objects',
	'list_objects',
	'search_objects',
	'list_relationships',
	'list_actors',
	'get_actor',
	'list_workspaces',
	'get_workspace_schema',
	'list_workspace_skills',
	'get_workspace_skill',
	'list_files',
	'get_file',
	'get_events',
	'get_comments',
	'list_triggers',
	'list_loops',
	'get_loop',
	'list_unread',
	'list_sessions',
	'get_session',
	'list_integrations',
	'list_integration_providers',
	'list_extensions',
	'get_started',
]

// Pure reads that are not in READ_TOOL_NAMES; they keep re-throwing on error.
const READS_OUTSIDE_READ_TOOL_NAMES = [
	'get_session_logs',
	'traverse_graph',
	'get_conversation',
	'list_conversation_messages',
	'get_session_activity',
	'list_notifications',
	'list_keychain_credentials',
	'desktop_list_ports',
]

// get_started is in READ_TOOL_NAMES but its confirm path installs a loop.
const NOT_READ_ONLY_DESPITE_READ_TOOL_NAMES = ['get_started']

// Tool names the default templates legitimately tell agents to call that live
// on another MCP server, so they are never in the Maskin tool list.
const EXTERNAL_TEMPLATE_TOOLS = new Set<string>(['get_pull_request'])

// Registered tools that no template may tell an agent to call. Empty today:
// create/list/update_notification are live for the Chief of Staff's For You list.
// The watchdog prompt says "Do NOT call create_notification", which is still fine.
const PROHIBITED_TEMPLATE_TOOLS = new Set<string>()

function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) for (const v of value) collectStrings(v, out)
	else if (value && typeof value === 'object') {
		for (const v of Object.values(value)) collectStrings(v, out)
	}
	return out
}

describe('MCP surface pin', () => {
	let registeredTools: Set<string>
	let registeredDefinitions: Map<string, Record<string, unknown>>
	let registeredHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let tools: typeof import('../tools').tools
	let MUTATION_TOOL_KINDS: typeof import('../telemetry').MUTATION_TOOL_KINDS
	let READ_TOOL_NAMES: typeof import('../read-error').READ_TOOL_NAMES
	let TOOL_ANNOTATIONS: typeof import('../annotations').TOOL_ANNOTATIONS
	let READ_ONLY_TOOLS: typeof import('../annotations').READ_ONLY_TOOLS

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		registeredTools = new Set()
		registeredDefinitions = new Map()
		registeredHandlers = new Map()

		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, definition, handler) => {
			registeredTools.add(name as string)
			registeredDefinitions.set(name as string, definition as Record<string, unknown>)
			registeredHandlers.set(
				name as string,
				handler as (args: Record<string, unknown>) => Promise<unknown>,
			)
		})

		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			// No-op sink so createMcpServer runs without touching the network.
			telemetrySink: () => {},
		})

		tools = (await import('../tools')).tools
		MUTATION_TOOL_KINDS = (await import('../telemetry')).MUTATION_TOOL_KINDS
		READ_TOOL_NAMES = (await import('../read-error')).READ_TOOL_NAMES
		;({ TOOL_ANNOTATIONS, READ_ONLY_TOOLS } = await import('../annotations'))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('registers at least one tool', () => {
		expect(registeredTools.size).toBeGreaterThan(0)
	})

	it('every tool name mentioned in a registered tool description is itself registered', () => {
		const violations: string[] = []

		for (const [toolName, def] of Object.entries(tools)) {
			if (!registeredTools.has(toolName)) continue
			const description = def.description ?? ''
			const seen = new Set<string>()
			for (const match of description.matchAll(TOOL_TOKEN_RE)) {
				const candidate = match[0]
				if (seen.has(candidate)) continue
				seen.add(candidate)
				if (NON_TOOL_TOKENS.has(candidate)) continue
				if (candidate === toolName) continue
				if (!registeredTools.has(candidate)) {
					violations.push(`${toolName} description references unregistered tool: ${candidate}`)
				}
			}
		}

		expect(violations, violations.join('\n')).toEqual([])
	})

	it('every tool name a default template mentions is registered', async () => {
		const shared = await import('@maskin/shared')
		const templates = {
			agents: shared.DEFAULT_WORKSPACE_AGENTS,
			triggers: shared.DEFAULT_WORKSPACE_TRIGGERS,
			loops: shared.DEFAULT_WORKSPACE_LOOPS,
			knowledge: shared.DEFAULT_WORKSPACE_KNOWLEDGE,
			developmentAgents: shared.DEVELOPMENT_AGENTS,
			developmentTriggers: shared.DEVELOPMENT_TRIGGERS,
			chiefOfStaff: [shared.CHIEF_OF_STAFF_SYSTEM_PROMPT, shared.CHIEF_OF_STAFF_DEFAULT],
			workspaceCoach: [shared.WORKSPACE_COACH_SYSTEM_PROMPT, shared.WORKSPACE_COACH_DEFAULT],
			skills: [
				shared.FOR_YOU_FORMAT_SKILL,
				shared.SHAPED_BET_FORMAT_SKILL,
				shared.MASKIN_WAY_OF_WORKING_SKILL,
				shared.CONTINUOUS_ONBOARDING_SKILL,
			],
		}
		const violations: string[] = []

		for (const [group, value] of Object.entries(templates)) {
			const seen = new Set<string>()
			for (const text of collectStrings(value)) {
				for (const match of text.matchAll(TOOL_TOKEN_RE)) {
					const candidate = match[0]
					if (seen.has(candidate)) continue
					seen.add(candidate)
					if (
						NON_TOOL_TOKENS.has(candidate) ||
						EXTERNAL_TEMPLATE_TOOLS.has(candidate) ||
						PROHIBITED_TEMPLATE_TOOLS.has(candidate)
					)
						continue
					if (!registeredTools.has(candidate)) {
						violations.push(`${group} template references unregistered tool: ${candidate}`)
					}
				}
			}
		}

		expect(violations, violations.join('\n')).toEqual([])
	})

	it('every alias row targets a registered tool', async () => {
		const { ALIASES, DEFAULT_WORKSPACE_TOOLS } = await import('../aliases')
		const violations: string[] = []
		for (const row of ALIASES) {
			if (!registeredTools.has(row.tool)) {
				violations.push(`alias row '${row.tool} ${row.oldPath}' targets an unregistered tool`)
			}
		}
		for (const name of DEFAULT_WORKSPACE_TOOLS) {
			if (!registeredTools.has(name)) {
				violations.push(`workspace_id fallback names an unregistered tool: ${name}`)
			}
		}
		expect(violations, violations.join('\n')).toEqual([])
	})

	it('every listed tool-name alias is registered, points at a registered tool, and stays within the cap', async () => {
		const { MAX_LISTED_TOOL_ALIASES, TOOL_NAME_ALIASES } = await import('../tool-aliases')
		const violations: string[] = []
		for (const [oldName, target] of Object.entries(TOOL_NAME_ALIASES)) {
			if (!registeredTools.has(oldName)) violations.push(`alias ${oldName} is not registered`)
			if (!registeredTools.has(target)) {
				violations.push(`alias ${oldName} points at unregistered tool ${target}`)
			}
		}
		expect(violations, violations.join('\n')).toEqual([])
		expect(Object.keys(TOOL_NAME_ALIASES).length).toBeLessThanOrEqual(MAX_LISTED_TOOL_ALIASES)
	})

	it('every MUTATION_TOOL_KINDS entry maps to a registered tool', () => {
		const violations: string[] = []
		for (const name of Object.keys(MUTATION_TOOL_KINDS)) {
			if (!registeredTools.has(name)) {
				violations.push(`MUTATION_TOOL_KINDS['${name}'] is not registered as a tool`)
			}
		}
		expect(violations, violations.join('\n')).toEqual([])
	})

	describe('annotations', () => {
		const annotated = () => [...registeredTools]

		it('every registered tool has a table entry', () => {
			const missing = annotated().filter((name) => !(name in TOOL_ANNOTATIONS))
			expect(missing, `registered tools without an annotations row: ${missing.join(', ')}`).toEqual(
				[],
			)
		})

		it('every table entry maps to a registered tool', () => {
			const orphans = Object.keys(TOOL_ANNOTATIONS).filter((name) => !registeredTools.has(name))
			expect(orphans, `annotations rows for unregistered tools: ${orphans.join(', ')}`).toEqual([])
		})

		it('the tool count in CLAUDE.md equals the number of registered tools', async () => {
			const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
			const claudeMd = readFileSync(new URL('../../../../CLAUDE.md', import.meta.url), 'utf8')
			const match = claudeMd.match(/wraps the API as (\d+) tools/)
			expect(match, 'CLAUDE.md no longer says "wraps the API as N tools"').not.toBeNull()
			expect(Number(match?.[1])).toBe(registeredTools.size)
		})

		it('gives every registered tool its title and annotations in one place (the wrapper)', () => {
			const violations: string[] = []
			for (const name of registeredTools) {
				const entry = TOOL_ANNOTATIONS[name]
				const def = registeredDefinitions.get(name)
				if (!entry || !def) continue
				if (def.title !== entry.title) violations.push(`${name}: title not forwarded`)
				expect(def.annotations).toEqual({
					readOnlyHint: entry.readOnlyHint,
					destructiveHint: entry.destructiveHint,
					idempotentHint: entry.idempotentHint,
					openWorldHint: entry.openWorldHint,
				})
				if (!entry.title.trim()) violations.push(`${name}: empty title`)
			}
			expect(violations, violations.join('\n')).toEqual([])
		})

		it('READ_TOOL_NAMES is exactly the list it was before the annotations PR', () => {
			expect([...READ_TOOL_NAMES]).toEqual(EXPECTED_READ_TOOL_NAMES)
		})

		it('readOnlyHint is true for exactly the pure reads, checked by name', () => {
			const expected = [
				...EXPECTED_READ_TOOL_NAMES.filter(
					(n) => !NOT_READ_ONLY_DESPITE_READ_TOOL_NAMES.includes(n),
				),
				...READS_OUTSIDE_READ_TOOL_NAMES,
			].sort()
			const actual = Object.entries(TOOL_ANNOTATIONS)
				.filter(([, entry]) => entry.readOnlyHint)
				.map(([name]) => name)
				.sort()
			expect(actual).toEqual(expected)
			expect([...READ_ONLY_TOOLS].sort()).toEqual(expected)
		})

		it('no MUTATION_TOOL_KINDS tool is read-only, nor create_session, mark_read or get_started', () => {
			const readOnly = (name: string) => TOOL_ANNOTATIONS[name]?.readOnlyHint
			for (const name of Object.keys(MUTATION_TOOL_KINDS)) {
				expect(readOnly(name), `${name} is a mutation but readOnlyHint is true`).toBe(false)
			}
			for (const name of ['create_session', 'mark_read', 'get_started']) {
				expect(readOnly(name), `${name} must not be read-only`).toBe(false)
			}
		})

		it('destructiveHint is true for every delete_* tool, stop_session, disconnect_integration and desktop_run only', () => {
			const expected = [
				...Object.keys(TOOL_ANNOTATIONS).filter((n) => n.startsWith('delete_')),
				'stop_session',
				'disconnect_integration',
				'desktop_run',
			].sort()
			const actual = Object.entries(TOOL_ANNOTATIONS)
				.filter(([, entry]) => entry.destructiveHint)
				.map(([name]) => name)
				.sort()
			expect(actual).toEqual(expected)
			for (const name of expected) expect(registeredTools.has(name)).toBe(true)
		})

		it('idempotentHint is true for update_*, delete_*, pause_session, resume_session and mark_read only', () => {
			const expected = [
				...Object.keys(TOOL_ANNOTATIONS).filter(
					(n) => n.startsWith('update_') || n.startsWith('delete_'),
				),
				'pause_session',
				'resume_session',
				'mark_read',
			].sort()
			const actual = Object.entries(TOOL_ANNOTATIONS)
				.filter(([, entry]) => entry.idempotentHint)
				.map(([name]) => name)
				.sort()
			expect(actual).toEqual(expected)
		})

		it('openWorldHint is true for create_session, the integration tools and the tools that send mail only', () => {
			const expected = [
				'create_session',
				'list_integrations',
				'list_integration_providers',
				'connect_integration',
				'disconnect_integration',
				'approve_object_draft',
				'gmail_send_email',
				'update_integration_access',
			].sort()
			const actual = Object.entries(TOOL_ANNOTATIONS)
				.filter(([, entry]) => entry.openWorldHint)
				.map(([name]) => name)
				.sort()
			expect(actual).toEqual(expected)
		})

		it('a read-only tool handler only ever sends GET requests', async () => {
			const methods: Array<{ tool: string; method: string }> = []
			let current = ''
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
				methods.push({ tool: current, method: String(init?.method ?? 'GET') })
				return {
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({}),
					text: () => Promise.resolve('{}'),
				} as Response
			})
			const args = {
				workspace_id: wsId,
				id: wsId,
				ids: [wsId],
				q: 'x',
				query: 'x',
				session_id: wsId,
				conversation_id: wsId,
				source_id: wsId,
				target_id: wsId,
				object_id: wsId,
				start_id: wsId,
			}
			for (const name of READ_ONLY_TOOLS) {
				const handler = registeredHandlers.get(name)
				expect(handler, `${name} is not registered`).toBeDefined()
				current = name
				try {
					await handler?.({ ...args })
				} catch {
					// get_session_logs and the other reads outside READ_TOOL_NAMES re-throw.
				}
			}
			expect(methods.length).toBeGreaterThan(0)
			const writes = methods.filter((m) => m.method !== 'GET')
			expect(writes, JSON.stringify(writes)).toEqual([])
		})

		it('a failing get_session_logs still throws', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve('boom'),
			} as Response)
			vi.spyOn(console, 'error').mockImplementation(() => {})

			const handler = registeredHandlers.get('get_session_logs')
			await expect(
				handler?.({ id: wsId, workspace_id: wsId, direction: 'desc', limit: 10 }),
			).rejects.toThrow()
		})

		it('a failing get_objects still reports the failure with a next hint, per id', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: false,
				status: 404,
				text: () => Promise.resolve('not found'),
			} as Response)
			vi.spyOn(console, 'error').mockImplementation(() => {})

			const handler = registeredHandlers.get('get_objects')
			const result = (await handler?.({ ids: [wsId], workspace_id: wsId })) as {
				content: Array<{ text: string }>
			}
			const [entry] = JSON.parse(result.content[0]?.text ?? '[]') as Array<{
				success: boolean
				error?: { next?: { tool?: string; hint?: string } }
			}>
			expect(entry?.success).toBe(false)
			expect(entry?.error?.next?.tool).toBeTruthy()
			expect(entry?.error?.next?.hint).toBeTruthy()
		})

		it('a thrown error in a READ_TOOL_NAMES tool still returns isError with a next hint', async () => {
			vi.spyOn(globalThis, 'fetch').mockResolvedValue({
				ok: false,
				status: 404,
				text: () => Promise.resolve('not found'),
			} as Response)
			vi.spyOn(console, 'error').mockImplementation(() => {})

			const handler = registeredHandlers.get('list_objects')
			const result = (await handler?.({ workspace_id: wsId })) as {
				isError?: boolean
				structuredContent?: { error?: { next?: { tool?: string; hint?: string } } }
			}
			expect(result.isError).toBe(true)
			expect(result.structuredContent?.error?.next?.tool).toBeTruthy()
			expect(result.structuredContent?.error?.next?.hint).toBeTruthy()
		})
	})
})
