import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('MCP surface pin', () => {
	let registeredTools: Set<string>
	let tools: typeof import('../tools').tools
	let MUTATION_TOOL_KINDS: typeof import('../telemetry').MUTATION_TOOL_KINDS

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		registeredTools = new Set()

		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name) => {
			registeredTools.add(name as string)
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

	it('every MUTATION_TOOL_KINDS entry maps to a registered tool', () => {
		const violations: string[] = []
		for (const name of Object.keys(MUTATION_TOOL_KINDS)) {
			if (!registeredTools.has(name)) {
				violations.push(`MUTATION_TOOL_KINDS['${name}'] is not registered as a tool`)
			}
		}
		expect(violations, violations.join('\n')).toEqual([])
	})
})
