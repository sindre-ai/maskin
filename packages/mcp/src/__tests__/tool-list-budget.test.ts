import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Same mock scaffold as surface-pin.test.ts: createMcpServer runs with no side
// effects and the registered definitions are the ground truth for tools/list.
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

// Measured 22 Nov 2026: 199,261 characters for 123 tools (name, title, description, JSON input
// schema and annotations of every tool, the same way the SDK builds tools/list). It leaves out
// the execution flag and _meta the wire list adds, which tool-list-wire-budget.test.ts counts.
// The budget leaves a little room, so a new tool is fine but a doubling is not. Raise it
// on purpose, with the new size in the PR, never to make a red test green.
const TOOL_LIST_BUDGET = 200_500
const PER_TOOL_BUDGET: Record<string, number> = {
	create_comment: 12_000,
	post_conversation_message: 7_000,
}

describe('tool list budget', () => {
	let sizes: Map<string, number>
	let inputShapes: Map<string, z.ZodRawShape>

	beforeEach(async () => {
		vi.clearAllMocks()
		vi.resetModules()
		sizes = new Map()
		inputShapes = new Map()

		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		const { normalizeObjectSchema } = await import('@modelcontextprotocol/sdk/server/zod-compat.js')
		const { toJsonSchemaCompat } = await import(
			'@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, definition) => {
			const def = definition as Record<string, unknown>
			const obj = def.inputSchema ? normalizeObjectSchema(def.inputSchema) : undefined
			const inputSchema = obj
				? toJsonSchemaCompat(obj, { strictUnions: true, pipeStrategy: 'input' })
				: { type: 'object', properties: {} }
			sizes.set(
				name as string,
				JSON.stringify({
					title: def.title,
					description: def.description,
					inputSchema,
					annotations: def.annotations,
				}).length,
			)
			inputShapes.set(name as string, (def.inputSchema ?? {}) as z.ZodRawShape)
		})

		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			telemetrySink: () => {},
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('keeps the whole tool list under its size budget', () => {
		const total = [...sizes.values()].reduce((a, b) => a + b, 0)
		expect(sizes.size).toBeGreaterThan(100)
		expect(total, `tool list is ${total} characters, budget ${TOOL_LIST_BUDGET}`).toBeLessThan(
			TOOL_LIST_BUDGET,
		)
	})

	it('keeps the two heaviest tools under their own budget', () => {
		for (const [tool, budget] of Object.entries(PER_TOOL_BUDGET)) {
			const size = sizes.get(tool) ?? 0
			expect(size, `${tool} is ${size} characters, budget ${budget}`).toBeLessThan(budget)
		}
	})

	describe('post_conversation_message metadata', () => {
		const parse = (metadata: unknown) =>
			z.object(inputShapes.get('post_conversation_message') ?? {}).safeParse({
				conversation_id: wsId,
				content: 'hi',
				metadata,
			})

		it('still accepts the keys an agent writes', () => {
			const result = parse({
				mentions: [wsId],
				context_objects: [{ id: wsId, title: 'A bet', type: 'bet' }],
				attachments: [{ file_id: wsId, name: 'a.txt' }],
			})
			expect(result.success).toBe(true)
		})

		it('still passes a card key through, so the handler can reject it by name', () => {
			const result = parse({ integration_connect: { provider: 'linear' } })
			expect(result.success).toBe(true)
			const data = result.success ? (result.data as { metadata?: Record<string, unknown> }) : null
			expect(data?.metadata).toHaveProperty('integration_connect')
		})

		it('still rejects a malformed key an agent writes', () => {
			expect(parse({ mentions: ['not-a-uuid'] }).success).toBe(false)
		})
	})
})
