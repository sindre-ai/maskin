import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent, TelemetrySink } from '../telemetry'
import { estimateTokensFromBytes } from '../telemetry'

// Hoisted mocks for ext-apps + sdk + node:fs so we can spin up the real
// createMcpServer wiring without any side effects, then drive the registered
// handlers directly to verify the token-cap wrapper.
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
import { decodeCursor, encodeCursor } from '../cursor'
import {
	DEFAULT_MAX_RESPONSE_TOKENS,
	MAX_FETCH_HANDLE_IDS,
	RESPONSE_TOKEN_CAP_ENV_VAR,
	TOKEN_CAP_TARGETS,
	applyResponseTokenCap,
	estimateResponseTokens,
	getMaxResponseTokens,
} from '../response-cap'
import { RESPONSE_SCOPING_ENV_VAR } from '../response-scoping'

const wsId = '00000000-0000-0000-0000-0000000000aa'

describe('getMaxResponseTokens', () => {
	it('returns the default when the env var is unset', () => {
		expect(getMaxResponseTokens({})).toBe(DEFAULT_MAX_RESPONSE_TOKENS)
	})

	it('returns the default on empty/whitespace/non-numeric/≤0 input', () => {
		expect(getMaxResponseTokens({ [RESPONSE_TOKEN_CAP_ENV_VAR]: '' })).toBe(
			DEFAULT_MAX_RESPONSE_TOKENS,
		)
		expect(getMaxResponseTokens({ [RESPONSE_TOKEN_CAP_ENV_VAR]: '   ' })).toBe(
			DEFAULT_MAX_RESPONSE_TOKENS,
		)
		expect(getMaxResponseTokens({ [RESPONSE_TOKEN_CAP_ENV_VAR]: 'nope' })).toBe(
			DEFAULT_MAX_RESPONSE_TOKENS,
		)
		expect(getMaxResponseTokens({ [RESPONSE_TOKEN_CAP_ENV_VAR]: '0' })).toBe(
			DEFAULT_MAX_RESPONSE_TOKENS,
		)
		expect(getMaxResponseTokens({ [RESPONSE_TOKEN_CAP_ENV_VAR]: '-1' })).toBe(
			DEFAULT_MAX_RESPONSE_TOKENS,
		)
	})

	it('honours a positive numeric override', () => {
		expect(getMaxResponseTokens({ [RESPONSE_TOKEN_CAP_ENV_VAR]: '5000' })).toBe(5000)
	})
})

describe('estimateResponseTokens', () => {
	it('returns 0 for null / undefined / primitive input', () => {
		expect(estimateResponseTokens(null)).toBe(0)
		expect(estimateResponseTokens(undefined)).toBe(0)
		expect(estimateResponseTokens(42)).toBe(0)
	})

	it('sums content + structuredContent + _meta bytes with the bytes/4 estimator', () => {
		const response = {
			content: [{ type: 'text', text: 'abcd' }], // 30 bytes for the JSON dump
			structuredContent: { x: 'yy' }, // 12 bytes
			_meta: { flag: true }, // 13 bytes
		}
		const contentBytes = Buffer.byteLength(JSON.stringify(response.content), 'utf8')
		const structBytes = Buffer.byteLength(JSON.stringify(response.structuredContent), 'utf8')
		const metaBytes = Buffer.byteLength(JSON.stringify(response._meta), 'utf8')
		const expected =
			estimateTokensFromBytes(contentBytes) +
			estimateTokensFromBytes(structBytes) +
			estimateTokensFromBytes(metaBytes)
		expect(estimateResponseTokens(response)).toBe(expected)
	})
})

describe('applyResponseTokenCap', () => {
	function makeObject(id: string, payloadKb: number) {
		return {
			id,
			type: 'bet',
			title: `Row ${id}`,
			body: 'x'.repeat(payloadKb * 1024),
		}
	}

	function makeListObjectsResponse(rows: Array<ReturnType<typeof makeObject>>) {
		return {
			_meta: { ui: { resourceUri: 'ui://objects' } },
			content: [{ type: 'text', text: `- ${rows.length} rows` }],
			structuredContent: {
				heroCard: { kind: 'list', tool: 'list_objects' },
				objects: rows,
				page: { limit: rows.length, offset: 0 },
			},
		}
	}

	it('passes through unchanged when the tool has no descriptor', () => {
		const response = makeListObjectsResponse([makeObject('a', 1)])
		const result = applyResponseTokenCap('get_workspace_schema', response, { maxTokens: 1 })
		expect(result.truncated).toBe(false)
		expect(result.response).toBe(response)
	})

	it('passes through unchanged when the response has no structuredContent', () => {
		const response = { content: [{ type: 'text', text: 'hi' }] }
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 1 })
		expect(result.truncated).toBe(false)
		expect(result.response).toBe(response)
	})

	it('passes through unchanged when structuredContent has no rows array', () => {
		const response = {
			structuredContent: { heroCard: { kind: 'empty', tool: 'list_objects' } },
		}
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 1 })
		expect(result.truncated).toBe(false)
		expect(result.response).toBe(response)
	})

	it('passes through unchanged when the response already fits under the cap', () => {
		const response = makeListObjectsResponse([makeObject('a', 1), makeObject('b', 1)])
		// Comfortably above the ~1KB response.
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 100_000 })
		expect(result.truncated).toBe(false)
		expect(result.response).toBe(response)
	})

	it('drops rows from the tail until the response fits under the cap (AC-T5)', () => {
		// Each row ~1KB → ~250 tokens with the bytes/4 estimator. Six rows put us
		// above a 1000-token cap; the wrapper drops rows until we come back under.
		const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => makeObject(id, 1))
		const response = makeListObjectsResponse(rows)
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 1000 })

		expect(result.truncated).toBe(true)
		const capped = result.response as {
			_meta: { truncated: boolean; fetch_handle: { tool: string; ids: string[] } }
			structuredContent: { objects: Array<{ id: string }> }
		}
		expect(capped._meta.truncated).toBe(true)
		expect(capped._meta.fetch_handle.tool).toBe('get_objects')

		// AC-T5: total response stays under the Claude Code 25K hard ceiling.
		expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(1000)

		// AC-U4: kept + omitted union is the original row set, in order.
		const keptIds = capped.structuredContent.objects.map((r) => r.id)
		const omittedIds = capped._meta.fetch_handle.ids
		expect([...keptIds, ...omittedIds]).toEqual(rows.map((r) => r.id))
	})

	it('preserves pre-existing _meta.ui when populating truncation metadata', () => {
		const rows = Array.from({ length: 6 }, (_, i) => makeObject(String(i), 1))
		const response = makeListObjectsResponse(rows)
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 1000 })
		const capped = result.response as { _meta: { ui?: unknown; truncated: boolean } }
		// Keep the widget URI so the client can still render the collapsed card.
		expect(capped._meta.ui).toEqual({ resourceUri: 'ui://objects' })
	})

	it('does not mutate the original response object', () => {
		const rows = Array.from({ length: 6 }, (_, i) => makeObject(String(i), 1))
		const response = makeListObjectsResponse(rows)
		const snapshot = JSON.parse(JSON.stringify(response))
		applyResponseTokenCap('list_objects', response, { maxTokens: 1000 })
		expect(response).toEqual(snapshot)
	})

	it('populates fetch_handle.tool from the descriptor (AC-U4)', () => {
		// list_workspace_skills → get_workspace_skill; id field is `name`.
		const skills = Array.from({ length: 6 }, (_, i) => ({
			id: `sk-${i}`,
			name: `skill-${i}`,
			body: 'y'.repeat(1024),
		}))
		const response = {
			content: [{ type: 'text', text: '- 6 skills' }],
			structuredContent: { skills },
		}
		const result = applyResponseTokenCap('list_workspace_skills', response, { maxTokens: 1000 })
		const capped = result.response as {
			_meta: { fetch_handle: { tool: string; ids: string[] } }
		}
		expect(capped._meta.fetch_handle.tool).toBe('get_workspace_skill')
		// idField=name: the fetch handle carries names, not the numeric id column.
		for (const value of capped._meta.fetch_handle.ids) {
			expect(value.startsWith('skill-')).toBe(true)
		}
	})

	it('caps fetch_handle.ids at MAX_FETCH_HANDLE_IDS so a single get_objects hop stays within its schema', () => {
		// 80 tiny rows → all-but-one get dropped, but fetch_handle.ids capped at 50.
		const rows = Array.from({ length: 80 }, (_, i) => makeObject(`o-${i}`, 2))
		const response = makeListObjectsResponse(rows)
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 200 })
		const capped = result.response as {
			_meta: { fetch_handle: { ids: string[] } }
		}
		expect(capped._meta.fetch_handle.ids.length).toBeLessThanOrEqual(MAX_FETCH_HANDLE_IDS)
		expect(MAX_FETCH_HANDLE_IDS).toBe(50)
	})

	// T4 follow-up: when the pre-trim payload has more omitted rows than
	// fetch_handle can carry, the response's inherited next_cursor points
	// past the omitted tail — rows between the 50th omitted id and the
	// original last row would be silently unrecoverable. The wrapper
	// rewrites next_cursor to the last recoverable row so a follow-up list
	// call resumes right after it.
	function makeRowWithCreatedAt(idx: number, payloadKb: number) {
		return {
			id: `obj-${String(idx).padStart(4, '0')}`,
			type: 'bet',
			title: `Row ${idx}`,
			createdAt: `2026-01-${String((idx % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
			body: 'x'.repeat(payloadKb * 1024),
		}
	}

	function makeListObjectsResponseWithCursor(
		rows: Array<ReturnType<typeof makeRowWithCreatedAt>>,
		snapshotAt: string,
	) {
		// Emulates the pre-trim shape server.ts produces when the pagination
		// upper bound is hit — a next_cursor is seeded from the last row.
		const last = rows[rows.length - 1]
		const inherited = encodeCursor({
			s: snapshotAt,
			o: 'desc',
			k: { sortValue: last.createdAt, id: last.id },
		})
		return {
			_meta: { ui: { resourceUri: 'ui://objects' } },
			content: [{ type: 'text', text: `- ${rows.length} rows` }],
			structuredContent: {
				heroCard: { kind: 'list', tool: 'list_objects' },
				objects: rows,
				next_cursor: inherited,
				page: { limit: rows.length, offset: 0, next_cursor: inherited },
			},
		}
	}

	it('rewrites next_cursor to the last recoverable row when omitted rows exceed MAX_FETCH_HANDLE_IDS', () => {
		// 100 rows, cap forces most to omit. fetch_handle covers the first 50
		// omitted; the next_cursor must point at that 50th omitted row so a
		// follow-up list call returns row 51 of the omitted tail onward.
		const snapshotAt = '2026-06-30T12:00:00.000Z'
		const rows = Array.from({ length: 100 }, (_, i) => makeRowWithCreatedAt(i, 1))
		const response = makeListObjectsResponseWithCursor(rows, snapshotAt)
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 500 })
		expect(result.truncated).toBe(true)

		const capped = result.response as {
			_meta: { fetch_handle: { ids: string[] } }
			structuredContent: {
				objects: Array<{ id: string }>
				next_cursor?: string
				page: { next_cursor?: string }
			}
		}

		const keptIds = capped.structuredContent.objects.map((r) => r.id)
		const fetchIds = capped._meta.fetch_handle.ids
		expect(fetchIds.length).toBe(MAX_FETCH_HANDLE_IDS)

		// The last recoverable row is the one whose id sits at
		// fetch_handle.ids[MAX_FETCH_HANDLE_IDS - 1].
		const boundaryId = fetchIds[fetchIds.length - 1]
		const boundaryRow = rows.find((r) => r.id === boundaryId)
		expect(boundaryRow).toBeDefined()
		if (!boundaryRow) throw new Error('boundary row missing')

		// The rewritten cursor decodes to that boundary row's keyset while
		// preserving the inherited snapshot and order.
		const decoded = decodeCursor(capped.structuredContent.next_cursor)
		expect(decoded).not.toBeNull()
		if (!decoded) throw new Error('decoded null')
		expect(decoded.s).toBe(snapshotAt)
		expect(decoded.o).toBe('desc')
		expect(decoded.k.id).toBe(boundaryRow.id)
		expect(decoded.k.sortValue).toBe(boundaryRow.createdAt)

		// The mirrored copy on `page.next_cursor` (T3 exposes the value on
		// both spots for backwards compatibility) is rewritten too.
		expect(capped.structuredContent.page.next_cursor).toBe(capped.structuredContent.next_cursor)

		// Recoverability contract: kept rows + fetch_handle ids together
		// cover the prefix of the pre-trim payload; every row past the
		// boundary row is still recoverable via a follow-up list call that
		// uses the rewritten cursor (keyset seek strictly past boundary).
		const boundaryIdx = rows.findIndex((r) => r.id === boundaryId)
		expect([...keptIds, ...fetchIds]).toEqual(rows.slice(0, boundaryIdx + 1).map((r) => r.id))
	})

	it('leaves next_cursor untouched when omitted rows fit inside fetch_handle', () => {
		// 30 rows, most get omitted but 30 ≤ 50 → every omitted row is in
		// fetch_handle.ids, no unrecoverable tail. The inherited cursor
		// already points past all omitted rows, so no rewrite is needed —
		// preserving it avoids a spurious cursor change for the common path.
		const snapshotAt = '2026-06-30T12:00:00.000Z'
		const rows = Array.from({ length: 30 }, (_, i) => makeRowWithCreatedAt(i, 1))
		const response = makeListObjectsResponseWithCursor(rows, snapshotAt)
		const inheritedCursor = response.structuredContent.next_cursor
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 500 })
		expect(result.truncated).toBe(true)
		const capped = result.response as {
			structuredContent: { next_cursor?: string; page: { next_cursor?: string } }
		}
		expect(capped.structuredContent.next_cursor).toBe(inheritedCursor)
		expect(capped.structuredContent.page.next_cursor).toBe(inheritedCursor)
	})

	it('leaves next_cursor untouched when the pre-trim payload had no cursor', () => {
		// No cursor in the pre-trim payload → the pagination upper bound
		// wasn't hit → there is no "past the omitted tail" to worry about.
		// The rewrite path must be a no-op even when omitted > 50.
		const rows = Array.from({ length: 100 }, (_, i) => makeRowWithCreatedAt(i, 1))
		const response = {
			_meta: { ui: { resourceUri: 'ui://objects' } },
			content: [{ type: 'text', text: `- ${rows.length} rows` }],
			structuredContent: {
				heroCard: { kind: 'list', tool: 'list_objects' },
				objects: rows,
				page: { limit: rows.length, offset: 0 },
			},
		}
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 500 })
		const capped = result.response as {
			structuredContent: {
				next_cursor?: string
				page: { next_cursor?: string; limit: number; offset: number }
			}
		}
		expect(capped.structuredContent.next_cursor).toBeUndefined()
		expect(capped.structuredContent.page.next_cursor).toBeUndefined()
	})

	it('handles the degenerate case where zero rows still exceed the cap', () => {
		// _meta alone is above a 5-token cap. The wrapper still returns a valid
		// truncated shape rather than looping — safer to ship a broken-looking
		// response than to hang.
		const rows = [makeObject('a', 1)]
		const response = {
			_meta: { padding: 'z'.repeat(4096) },
			content: [{ type: 'text', text: '- 1 row' }],
			structuredContent: { objects: rows },
		}
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 5 })
		expect(result.truncated).toBe(true)
		const capped = result.response as {
			_meta: { truncated: boolean; fetch_handle: { ids: string[] } }
			structuredContent: { objects: unknown[] }
		}
		expect(capped._meta.truncated).toBe(true)
		expect(capped.structuredContent.objects).toEqual([])
		expect(capped._meta.fetch_handle.ids).toEqual(['a'])
	})

	it('reads the token override from process.env when no explicit maxTokens is passed', () => {
		const rows = Array.from({ length: 6 }, (_, i) => makeObject(String(i), 1))
		const response = makeListObjectsResponse(rows)
		try {
			process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '1000'
			const result = applyResponseTokenCap('list_objects', response)
			expect(result.truncated).toBe(true)
		} finally {
			delete process.env[RESPONSE_TOKEN_CAP_ENV_VAR]
		}
	})

	it('registers the tools called out in the task DoD', () => {
		// Locks the registry so a rename in server.ts doesn't silently drop
		// truncation coverage for a tool the bet's AC list assumes is covered.
		expect(TOKEN_CAP_TARGETS).toHaveProperty('list_objects')
		expect(TOKEN_CAP_TARGETS).toHaveProperty('search_objects')
		expect(TOKEN_CAP_TARGETS.list_objects.fetchHandleTool).toBe('get_objects')
		expect(TOKEN_CAP_TARGETS.search_objects.fetchHandleTool).toBe('get_objects')
	})
})

describe('token-cap wired into createMcpServer (AC-T5 / AC-T6 end-to-end)', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let recorded: TelemetryEvent[]

	function bigObjectRow(idx: number) {
		return {
			id: `obj-${String(idx).padStart(12, '0')}`,
			type: 'bet',
			title: `Bet ${idx}`,
			status: 'active',
			driver: null,
			metadata: { padding: 'x'.repeat(3072) },
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-06-01T00:00:00.000Z',
		}
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		handlers = new Map()
		recorded = []
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		const captureSink: TelemetrySink = (event) => {
			recorded.push(event)
		}
		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey',
			defaultWorkspaceId: wsId,
			webAppBaseUrl: 'https://maskin.io',
			telemetrySink: captureSink,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		delete process.env[RESPONSE_SCOPING_ENV_VAR]
		delete process.env[RESPONSE_TOKEN_CAP_ENV_VAR]
	})

	function stubApi(fixture: unknown[]) {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const urlStr = url as string
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

	it('list_objects: oversized payload gets trimmed, telemetry sees truncated=true (AC-T5)', async () => {
		process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
		// Drop the cap way below the default so a modest fixture triggers trim
		// without needing to seed a MB of data.
		process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '2000'

		// 25 rows × ~3KB each ≈ 75KB serialized — well above the 2000-token cap.
		const fixture = Array.from({ length: 25 }, (_, i) => bigObjectRow(i))
		stubApi(fixture)

		const handler = handlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')
		const result = (await handler({})) as {
			_meta: { truncated?: boolean; fetch_handle?: { tool: string; ids: string[] } }
			content: Array<{ text: string }>
			structuredContent: { objects: Array<{ id: string }>; heroCard: unknown; page: unknown }
		}

		// DoD (1): _meta.truncated=true
		expect(result._meta.truncated).toBe(true)
		// DoD (2): fetch_handle populated correctly
		expect(result._meta.fetch_handle?.tool).toBe('get_objects')
		expect(Array.isArray(result._meta.fetch_handle?.ids)).toBe(true)
		expect((result._meta.fetch_handle?.ids ?? []).length).toBeGreaterThan(0)
		// DoD (3): total serialized response under the Claude Code 25K ceiling.
		expect(estimateResponseTokens(result)).toBeLessThanOrEqual(25_000)
		// The kept + omitted union covers the (scoped-page) result.
		const keptIds = result.structuredContent.objects.map((r) => r.id)
		const omittedIds = result._meta.fetch_handle?.ids ?? []
		expect([...keptIds, ...omittedIds].length).toBeGreaterThan(0)

		// DoD (4): the response-size telemetry event carries truncated=true.
		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		expect(sizeEvents).toHaveLength(1)
		const [evt] = sizeEvents
		if (evt.event_type !== 'tool_call_response_size') throw new Error('narrowing')
		expect(evt.tool_name).toBe('list_objects')
		expect(evt.truncated).toBe(true)
	})

	it('flag OFF: token-cap wrapper is a no-op even on an oversized payload (AC-T4)', async () => {
		// The flag off means the pre-scoping shape ships verbatim — even if the
		// response would be enormous, the wrapper must not touch it.
		delete process.env[RESPONSE_SCOPING_ENV_VAR]
		process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '2000'

		const fixture = Array.from({ length: 25 }, (_, i) => bigObjectRow(i))
		stubApi(fixture)

		const handler = handlers.get('list_objects')
		if (!handler) throw new Error('list_objects handler not registered')
		const result = (await handler({})) as { _meta?: { truncated?: boolean } }

		// Truncated flag is absent (flag-off keeps the original _meta unchanged).
		expect(result._meta?.truncated).toBeUndefined()

		const sizeEvents = recorded.filter((r) => r.event_type === 'tool_call_response_size')
		if (sizeEvents[0]?.event_type !== 'tool_call_response_size') throw new Error('narrowing')
		expect(sizeEvents[0].truncated).toBe(false)
	})

	it('AC-T6: calling fetch_handle.tool with fetch_handle.ids returns the omitted rows without re-truncation', async () => {
		process.env[RESPONSE_SCOPING_ENV_VAR] = '1'
		process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '2000'

		const fixture = Array.from({ length: 25 }, (_, i) => bigObjectRow(i))
		const rowsById = new Map(fixture.map((r) => [r.id, r]))

		// Stub the two API paths list_objects and get_objects hit — list returns
		// the full fixture, get_objects returns per-id graph objects.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			const urlStr = url as string
			if (urlStr.includes('/api/actors?ids=')) {
				return { ok: true, json: () => Promise.resolve([]) } as Response
			}
			const graphMatch = urlStr.match(/\/api\/objects\/([^/?]+)\/graph/)
			if (graphMatch) {
				const id = graphMatch[1]
				const obj = rowsById.get(id)
				return {
					ok: true,
					headers: new Headers(),
					json: () => Promise.resolve({ object: obj, relationships: [] }),
				} as Response
			}
			return {
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve(fixture),
			} as Response
		})

		const listHandler = handlers.get('list_objects')
		const getHandler = handlers.get('get_objects')
		if (!listHandler || !getHandler) throw new Error('handlers not registered')

		const listResult = (await listHandler({})) as {
			_meta: { fetch_handle?: { tool: string; ids: string[] } }
		}
		expect(listResult._meta.fetch_handle?.tool).toBe('get_objects')
		const omittedIds = listResult._meta.fetch_handle?.ids ?? []
		expect(omittedIds.length).toBeGreaterThan(0)

		// Empty the telemetry buffer so we can assert on the get_objects call
		// specifically.
		recorded.length = 0

		const followUp = (await getHandler({ ids: omittedIds })) as {
			_meta?: { truncated?: boolean }
			structuredContent: { objects: unknown[] }
		}

		// The follow-up must NOT be re-truncated: get_objects returns the full
		// payload for the requested ids. (get_objects is not in
		// TOKEN_CAP_TARGETS, so even if the shape overflowed the cap the wrapper
		// wouldn't touch it — which is precisely the "no re-truncation"
		// guarantee AC-T6 asks for.)
		expect(followUp._meta?.truncated).toBeUndefined()
		expect(followUp.structuredContent.objects).toHaveLength(omittedIds.length)
	})
})
