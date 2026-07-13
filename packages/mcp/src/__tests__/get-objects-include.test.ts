import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK modules the same way server.test.ts does — we only need
// registerAppTool to intercept the get_objects handler so we can drive it
// directly with args and assert on the returned envelope.
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

const apiTestKey = 'ank_testkey123'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: apiTestKey,
	defaultWorkspaceId: 'ws-default-123',
	webAppBaseUrl: 'https://maskin.example.com',
	telemetrySink: () => {},
}

// Deterministic graph payload the /api/objects/:id/graph mock returns for
// every id. Every block the `include` enum can request is populated so the
// tests can assert both presence (when opted in) and absence (when not).
const GRAPH_PAYLOAD = {
	object: {
		id: 'bet-9',
		type: 'bet',
		title: 'Bet Nine',
		status: 'active',
		content: '## Brief\n\nSome markdown body',
		driver: null,
		metadata: {},
		workspaceId: 'ws-default-123',
		createdAt: '2026-06-01T00:00:00.000Z',
		updatedAt: '2026-06-30T00:00:00.000Z',
	},
	relationships: [
		{
			id: 'rel-1',
			sourceId: 'bet-9',
			targetId: 'task-1',
			type: 'breaks_into',
			sourceTitle: 'Bet Nine',
			targetTitle: 'Task One',
		},
	],
	connected_objects: [{ id: 'task-1', type: 'task', title: 'Task One', status: 'todo' }],
	events: [{ id: 42, action: 'created', entityId: 'bet-9', createdAt: '2026-06-01T00:00:00.000Z' }],
	files: [
		{
			id: 'file-1',
			name: 'brief.pdf',
			mimeType: 'application/pdf',
			sizeBytes: 1024,
			url: 'https://maskin.example.com/ws-default-123/files/file-1',
		},
	],
}

const CORE_OBJECT_KEYS = ['id', 'type', 'title', 'status', 'contextLine', 'url', 'workspaceId']
const EXPANSION_BLOCK_KEYS = ['relationships', 'connected_objects', 'events', 'files'] as const
type ExpansionBlockKey = (typeof EXPANSION_BLOCK_KEYS)[number]

describe('get_objects `include:` expansions', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()

		// Re-apply the McpServer mock impl — vi.restoreAllMocks() in the previous
		// suite's afterEach clears it, and setting webAppBaseUrl activates the
		// registerObjectResources() path that reads server.registerResource.
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})

		createMcpServer(config)

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const urlStr = url as string
			if (urlStr.includes('/api/objects/bet-9/graph')) {
				return { ok: true, json: () => Promise.resolve(GRAPH_PAYLOAD) } as Response
			}
			return { ok: true, json: () => Promise.resolve([]) } as Response
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	async function callGetObjects(args: Record<string, unknown>) {
		const handler = getHandler('get_objects')
		return (await handler(args)) as {
			content: Array<{ text: string }>
			structuredContent: {
				results: Array<{ id: string; success: boolean; error?: string }>
				objects: Array<{
					object?: Record<string, unknown>
					content?: unknown
					relationships?: unknown[]
					connected_objects?: unknown[]
					events?: unknown[]
					files?: unknown[]
				}>
			}
		}
	}

	describe('(a) default — `include: []` returns the T3 lean projection only', () => {
		it('returns only {id, type, title, status, contextLine, url} on each object', async () => {
			const result = await callGetObjects({ ids: ['bet-9'] })

			expect(result.structuredContent.results[0].success).toBe(true)
			const entry = result.structuredContent.objects[0]
			expect(Object.keys(entry).sort()).toEqual(['object'])
			const projected = entry.object as Record<string, unknown>
			expect(Object.keys(projected).sort()).toEqual([...CORE_OBJECT_KEYS].sort())
			expect(projected.id).toBe('bet-9')
			expect(projected.type).toBe('bet')
			expect(projected.title).toBe('Bet Nine')
			expect(projected.status).toBe('active')
			expect(typeof projected.contextLine).toBe('string')
			expect(typeof projected.url).toBe('string')
		})

		it('behaves the same when `include` is omitted altogether', async () => {
			const result = await callGetObjects({ ids: ['bet-9'] })
			const entryKeys = Object.keys(result.structuredContent.objects[0]).sort()
			expect(entryKeys).toEqual(['object'])
		})

		it('mirrors the projection onto structuredContent.objects[]', async () => {
			const result = await callGetObjects({ ids: ['bet-9'] })
			const first = result.structuredContent.objects[0]
			expect(Object.keys(first).sort()).toEqual(['object'])
			const projected = first.object as Record<string, unknown>
			expect(Object.keys(projected).sort()).toEqual([...CORE_OBJECT_KEYS].sort())
		})
	})

	describe('(b) each single `include: [X]` returns default + only block X', () => {
		it.each(EXPANSION_BLOCK_KEYS)('adds only the `%s` block', async (block: ExpansionBlockKey) => {
			const result = await callGetObjects({ ids: ['bet-9'], include: [block] })
			const entry = result.structuredContent.objects[0]

			// The core object body is untouched (still the lean 6-field default).
			const projected = entry.object as Record<string, unknown>
			expect(Object.keys(projected).sort()).toEqual([...CORE_OBJECT_KEYS].sort())

			// The canonical body entry has exactly one extra top-level key: the block.
			expect(Object.keys(entry).sort()).toEqual(['object', block].sort())
			expect(Array.isArray(entry[block])).toBe(true)
		})

		it('adds `content` as a field on the object body, not a top-level block', async () => {
			const result = await callGetObjects({ ids: ['bet-9'], include: ['content'] })
			const entry = result.structuredContent.objects[0]

			// Top-level entry still has only `object`.
			expect(Object.keys(entry).sort()).toEqual(['object'])

			// The object body grows by exactly one field: `content`.
			const projected = entry.object as Record<string, unknown>
			expect(Object.keys(projected).sort()).toEqual([...CORE_OBJECT_KEYS, 'content'].sort())
			expect(projected.content).toBe('## Brief\n\nSome markdown body')
		})
	})

	describe('(c) `include: [X, Y]` returns default + blocks X and Y and no others', () => {
		it('adds both blocks and no others when include lists two', async () => {
			const result = await callGetObjects({
				ids: ['bet-9'],
				include: ['relationships', 'events'],
			})
			const entry = result.structuredContent.objects[0]

			expect(Object.keys(entry).sort()).toEqual(['events', 'object', 'relationships'])
			expect(entry.relationships).toHaveLength(1)
			expect(entry.events).toHaveLength(1)

			// The object body is still the lean 6-field default.
			const projected = entry.object as Record<string, unknown>
			expect(Object.keys(projected).sort()).toEqual([...CORE_OBJECT_KEYS].sort())
		})

		it('when include lists every block, all blocks appear and none more', async () => {
			const result = await callGetObjects({
				ids: ['bet-9'],
				include: ['content', 'relationships', 'connected_objects', 'events', 'files'],
			})
			const entry = result.structuredContent.objects[0]

			// content flows into the object body; the other 4 land as peers of `object`.
			expect(Object.keys(entry).sort()).toEqual(
				['object', 'relationships', 'connected_objects', 'events', 'files'].sort(),
			)
			const projected = entry.object as Record<string, unknown>
			expect(Object.keys(projected).sort()).toEqual([...CORE_OBJECT_KEYS, 'content'].sort())
		})
	})

	describe('unknown `include` values are rejected at Zod validation time', () => {
		it('rejects at the schema layer — never reaches the handler', () => {
			const parsed = tools.get_objects.inputSchema.safeParse({
				ids: ['00000000-0000-0000-0000-000000000001'],
				include: ['bogus'],
			})
			expect(parsed.success).toBe(false)
			if (!parsed.success) {
				const includeIssue = parsed.error.issues.find((i) => i.path.includes('include'))
				expect(includeIssue).toBeDefined()
			}
		})

		it('accepts every enum value listed in the ADR', () => {
			const parsed = tools.get_objects.inputSchema.safeParse({
				ids: ['00000000-0000-0000-0000-000000000001'],
				include: ['content', 'relationships', 'connected_objects', 'events', 'files'],
			})
			expect(parsed.success).toBe(true)
		})
	})
})
