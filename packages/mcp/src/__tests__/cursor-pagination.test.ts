import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mocking envelope as response-scoping.test.ts — stubs the SDK + ext-apps
// + node:fs so `createMcpServer` wires up without side effects and every
// registered handler is captured in a Map for direct invocation.
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
import { decodeCursor } from '../cursor'
import { RESPONSE_SCOPING_ENV_VAR } from '../response-scoping'
import { createMcpServer } from '../server'

const wsId = '00000000-0000-0000-0000-0000000000aa'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: wsId,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>

// A cursor page returned by any of the seven tools normalises to this shape —
// the row-carrying field name varies (loops / actors / integrations / etc.)
// but every tool exposes it under `structuredContent` alongside `next_cursor`.
type PageResponse = {
	content: Array<{ text: string }>
	structuredContent?: Record<string, unknown> & { next_cursor?: string }
}

function uuid(prefix: string, idx: number): string {
	const pad = String(idx).padStart(12, '0')
	return `${prefix}-0000-0000-0000-${pad}`
}

// ISO timestamp descending by index — index 0 is newest, index N is oldest —
// so a `desc` cursor walk over 30 rows produces the same ordering every hop.
function ts(idx: number): string {
	const day = 30 - idx
	return `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`
}

// Factories per tool. Each one carries a unique id + a `createdAt` timestamp
// so the client-side keyset paginator has a stable primary sort value; the
// last-page assertion depends on ordering being deterministic.
function loopRow(idx: number) {
	return {
		id: uuid('11111111', idx),
		workspaceId: wsId,
		type: 'loop',
		title: `Loop ${idx}`,
		status: 'running',
		createdAt: ts(idx),
	}
}
function workspaceRow(idx: number) {
	return {
		id: uuid('22222222', idx),
		name: `Workspace ${idx}`,
		role: 'owner',
		createdAt: ts(idx),
	}
}
function integrationRow(idx: number) {
	return {
		id: uuid('33333333', idx),
		workspaceId: wsId,
		provider: 'github',
		status: 'active',
		externalId: null,
		config: {},
		createdBy: uuid('99999999', 0),
		createdAt: ts(idx),
		updatedAt: ts(idx),
	}
}
function unreadRow(idx: number) {
	return {
		entity_type: 'object',
		entity_id: uuid('55555555', idx),
		unread_count: 3,
		mentioning_unread_count: 0,
		latest_event_id: 1000 + idx,
		latest_activity_at: ts(idx),
	}
}
function eventRow(idx: number) {
	return {
		id: 1000 + idx,
		workspaceId: wsId,
		actorId: uuid('99999999', 0),
		action: 'created',
		entityType: 'object',
		entityId: uuid('66666666', idx),
		data: {},
		createdAt: ts(idx),
	}
}

// list_extensions is derived from `/api/workspaces` (settings) + registered
// modules. Each distinct id in `custom_extensions` becomes its own extension
// entry, so seeding N custom extensions is the reliable way to get N pageable
// rows (untracked types collapse into a single "Custom Types" entry and don't
// scale up count-wise).
function extensionsWorkspaceFixture(count: number) {
	const statuses: Record<string, string[]> = {}
	const displayNames: Record<string, string> = {}
	const customExtensions: Record<
		string,
		{ name: string; types: string[]; enabled?: boolean; relationship_types?: string[] }
	> = {}
	for (let i = 0; i < count; i++) {
		const extId = `custom_${String(i).padStart(3, '0')}`
		const typeKey = `type_${String(i).padStart(3, '0')}`
		statuses[typeKey] = ['todo', 'done']
		displayNames[typeKey] = `Type ${i}`
		customExtensions[extId] = { name: `Custom ${i}`, types: [typeKey] }
	}
	return [
		{
			id: wsId,
			name: 'Workspace',
			settings: {
				statuses,
				display_names: displayNames,
				relationship_types: [],
				custom_extensions: customExtensions,
			},
		},
	]
}

describe('cursor pagination — seven previously-unpaginated tools', () => {
	let handlers: Map<string, Handler>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as Handler)
		})
		createMcpServer(config)
		process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
	})

	afterEach(() => {
		vi.restoreAllMocks()
		delete process.env[RESPONSE_SCOPING_ENV_VAR]
	})

	function getHandler(name: string): Handler {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`handler ${name} not registered`)
		return handler
	}

	function stubFetch(fixture: unknown) {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return {
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve(fixture),
			} as Response
		})
	}

	// Each entry pairs a tool with its API-response wrapper shape and the
	// structuredContent row field the handler emits, so the three-per-tool
	// assertions below (has-cursor, no-cursor, walk-continues) can share one
	// generic body.
	type ToolCase = {
		tool: string
		args?: Record<string, unknown>
		buildRow: (idx: number) => Record<string, unknown>
		/** Wrap the row array in whatever shape the underlying API returns. */
		wrapApiResponse: (rows: unknown[]) => unknown
		/** Field on structuredContent that carries the paged rows. */
		rowsField: string
		/** How to read the id off a row in structuredContent (for overlap check). */
		getId: (row: unknown) => string
		/**
		 * Extract the row array from `JSON.parse(content[0].text)`. Defaults to
		 * reading the same `rowsField` key structuredContent uses; only
		 * `get_events` ships content as a bare array instead of a wrapped
		 * object, so it overrides this.
		 */
		contentRowsOf?: (parsed: unknown) => unknown[]
	}

	const cases: ToolCase[] = [
		{
			tool: 'list_loops',
			buildRow: loopRow,
			wrapApiResponse: (rows) => ({ loops: rows }),
			rowsField: 'loops',
			getId: (row) => (row as { id: string }).id,
		},
		{
			tool: 'list_workspaces',
			buildRow: workspaceRow,
			wrapApiResponse: (rows) => rows,
			rowsField: 'workspaces',
			getId: (row) => (row as { id: string }).id,
		},
		{
			tool: 'list_integrations',
			buildRow: integrationRow,
			wrapApiResponse: (rows) => rows,
			rowsField: 'integrations',
			getId: (row) => (row as { id: string }).id,
		},
		{
			tool: 'list_unread',
			buildRow: unreadRow,
			wrapApiResponse: (rows) => ({ items: rows }),
			rowsField: 'items',
			getId: (row) => (row as { entity_id: string }).entity_id,
		},
		{
			tool: 'get_events',
			buildRow: eventRow,
			wrapApiResponse: (rows) => rows,
			rowsField: 'events',
			getId: (row) => String((row as { id: number }).id).padStart(20, '0'),
			contentRowsOf: (parsed) => parsed as unknown[],
		},
	]

	for (const c of cases) {
		describe(c.tool, () => {
			it('returns next_cursor when rows exceed limit', async () => {
				const fixture = Array.from({ length: 30 }, (_, i) => c.buildRow(i))
				stubFetch(c.wrapApiResponse(fixture))
				const handler = getHandler(c.tool)
				const result = (await handler({ ...(c.args ?? {}), limit: 10 })) as PageResponse
				expect(result.structuredContent).toBeDefined()
				expect(result.structuredContent?.next_cursor).toBeTypeOf('string')
				const decoded = decodeCursor(result.structuredContent?.next_cursor as string)
				expect(decoded).not.toBeNull()
				const rows = result.structuredContent?.[c.rowsField] as unknown[]
				expect(Array.isArray(rows)).toBe(true)
				expect(rows.length).toBe(10)
			})

			it('omits next_cursor on the last page', async () => {
				const fixture = Array.from({ length: 5 }, (_, i) => c.buildRow(i))
				stubFetch(c.wrapApiResponse(fixture))
				const handler = getHandler(c.tool)
				const result = (await handler({ ...(c.args ?? {}), limit: 10 })) as PageResponse
				expect(result.structuredContent?.next_cursor).toBeUndefined()
			})

			it('passing next_cursor yields the next non-overlapping page', async () => {
				const fixture = Array.from({ length: 30 }, (_, i) => c.buildRow(i))
				stubFetch(c.wrapApiResponse(fixture))
				const handler = getHandler(c.tool)
				const first = (await handler({ ...(c.args ?? {}), limit: 10 })) as PageResponse
				const firstRows = first.structuredContent?.[c.rowsField] as unknown[]
				const nextCursor = first.structuredContent?.next_cursor as string
				expect(nextCursor).toBeTypeOf('string')

				const second = (await handler({
					...(c.args ?? {}),
					limit: 10,
					cursor: nextCursor,
				})) as PageResponse
				const secondRows = second.structuredContent?.[c.rowsField] as unknown[]
				expect(secondRows.length).toBe(10)

				const firstIds = new Set(firstRows.map(c.getId))
				for (const row of secondRows) {
					expect(firstIds.has(c.getId(row))).toBe(false)
				}
			})

			it('content channel mirrors the paginated page, not the full unpaginated fixture', async () => {
				// Regression guard: server.ts previously fed the raw, unpaginated
				// `result` into buildListContentText() for list_workspaces /
				// list_integrations / list_unread (and list_extensions, tested
				// separately below), so `content` leaked every row regardless of
				// the requested page. Fixed to pass the paginated rows instead.
				const fixture = Array.from({ length: 30 }, (_, i) => c.buildRow(i))
				stubFetch(c.wrapApiResponse(fixture))
				const handler = getHandler(c.tool)
				const result = (await handler({ ...(c.args ?? {}), limit: 10 })) as PageResponse

				const structuredRows = result.structuredContent?.[c.rowsField] as unknown[]
				expect(structuredRows.length).toBe(10)

				const parsed = JSON.parse(result.content[0].text)
				const contentRows = (
					c.contentRowsOf ?? ((p) => (p as Record<string, unknown>)[c.rowsField])
				)(parsed) as unknown[]
				expect(Array.isArray(contentRows)).toBe(true)
				// The bug this guards: content built from the raw unpaginated
				// `result` would carry all 30 fixture rows here instead of the
				// requested 10-row page.
				expect(contentRows.length).toBe(10)
				expect(contentRows.length).toBeLessThan(fixture.length)

				const structuredIds = new Set(structuredRows.map(c.getId))
				for (const row of contentRows) {
					expect(structuredIds.has(c.getId(row))).toBe(true)
				}
			})
		})
	}

	// list_extensions has no per-row createdAt — its cursor uses the string id
	// and skips snapshot filtering. Assertions match the other six but the
	// fixture is built differently because the handler derives extensions from
	// `/api/workspaces` settings, not a direct row list.
	describe('list_extensions', () => {
		it('returns next_cursor when rows exceed limit', async () => {
			stubFetch(extensionsWorkspaceFixture(30))
			const handler = getHandler('list_extensions')
			const result = (await handler({ limit: 10 })) as PageResponse
			expect(result.structuredContent?.next_cursor).toBeTypeOf('string')
			const rows = result.structuredContent?.extensions as unknown[]
			// One entry may be the aggregated "Custom Types" container, so we
			// assert the caller-visible page bound, not a specific integer.
			expect(rows.length).toBe(10)
		})

		it('omits next_cursor on the last page', async () => {
			stubFetch(extensionsWorkspaceFixture(3))
			const handler = getHandler('list_extensions')
			const result = (await handler({ limit: 25 })) as PageResponse
			expect(result.structuredContent?.next_cursor).toBeUndefined()
		})

		it('passing next_cursor yields the next non-overlapping page', async () => {
			stubFetch(extensionsWorkspaceFixture(30))
			const handler = getHandler('list_extensions')
			const first = (await handler({ limit: 10 })) as PageResponse
			const firstIds = new Set(
				(first.structuredContent?.extensions as Array<{ id: string }>).map((r) => r.id),
			)
			const cursor = first.structuredContent?.next_cursor as string
			expect(cursor).toBeTypeOf('string')

			const second = (await handler({ limit: 10, cursor })) as PageResponse
			const secondRows = second.structuredContent?.extensions as Array<{ id: string }>
			expect(secondRows.length).toBe(10)
			for (const row of secondRows) {
				expect(firstIds.has(row.id)).toBe(false)
			}
		})

		it('content channel mirrors the paginated page, not the full unpaginated fixture', async () => {
			// Regression guard: server.ts previously fed the raw, unpaginated
			// `result` into buildListContentText() here too, so `content` leaked
			// every extension regardless of the requested page.
			stubFetch(extensionsWorkspaceFixture(30))
			const handler = getHandler('list_extensions')
			const result = (await handler({ limit: 10 })) as PageResponse

			const structuredRows = result.structuredContent?.extensions as Array<{ id: string }>
			expect(structuredRows.length).toBe(10)

			const parsed = JSON.parse(result.content[0].text) as { extensions: Array<{ id: string }> }
			expect(Array.isArray(parsed.extensions)).toBe(true)
			expect(parsed.extensions.length).toBe(10)

			const structuredIds = new Set(structuredRows.map((r) => r.id))
			for (const row of parsed.extensions) {
				expect(structuredIds.has(row.id)).toBe(true)
			}
		})
	})
})
