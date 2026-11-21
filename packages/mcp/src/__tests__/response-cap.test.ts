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
	RECORD_CAP_TARGETS,
	RESPONSE_TOKEN_CAP_ENV_VAR,
	RESUME_CURSOR,
	TOKEN_CAP_TARGETS,
	applyResponseTokenCap,
	estimateResponseTokens,
	getMaxResponseTokens,
} from '../response-cap'

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

	// `content` now ships the same full-JSON payload as `structuredContent`
	// (the lean markdown-summary channel was reverted), so a trim that only
	// rewrote `structuredContent` would leave `content` at its full, pre-trim
	// size — the loop could never converge under the cap. `capContentToStructured`
	// mirrors `content[0].text` to the just-trimmed `structuredContent` on every
	// iteration to fix that. These tests exercise it directly.
	describe('content channel mirroring (capContentToStructured)', () => {
		function makeFullJsonResponse(rows: Array<ReturnType<typeof makeObject>>) {
			// Mirrors the real shape server.ts produces post-revert: `content` is
			// `JSON.stringify(enriched)` — a bare row array — while
			// `structuredContent` is the richer wrapped object.
			return {
				_meta: { ui: { resourceUri: 'ui://objects' } },
				content: [{ type: 'text', text: JSON.stringify(rows) }],
				structuredContent: {
					heroCard: { kind: 'list', tool: 'list_objects' },
					objects: rows,
					page: { limit: rows.length, offset: 0 },
				},
			}
		}

		it('rewrites content[0].text to mirror the trimmed structuredContent, not the original untrimmed payload', () => {
			const rows = Array.from({ length: 6 }, (_, i) => makeObject(String(i), 1))
			const response = makeFullJsonResponse(rows)
			const result = applyResponseTokenCap('list_objects', response, { maxTokens: 1000 })

			expect(result.truncated).toBe(true)
			const capped = result.response as {
				content: Array<{ text: string }>
				structuredContent: { objects: Array<{ id: string }> }
			}

			// The regression this guards: before the fix, content stayed the full
			// 6-row JSON dump on every trim iteration, so the loop's post-trim
			// size check never saw content shrink — it could drop every row and
			// still overshoot the cap.
			expect(capped.structuredContent.objects.length).toBeLessThan(rows.length)
			const parsedContent = JSON.parse(capped.content[0].text)
			expect(parsedContent).toEqual(capped.structuredContent)

			// The whole point: content's own byte size shrank along with the row
			// cap, instead of staying pinned at the original 6-row dump.
			const originalContentBytes = Buffer.byteLength(response.content[0].text, 'utf8')
			const cappedContentBytes = Buffer.byteLength(capped.content[0].text, 'utf8')
			expect(cappedContentBytes).toBeLessThan(originalContentBytes)
		})

		it('leaves content untouched when a multi-block content array is present (only rewrites the single-text-block shape every list/search tool emits)', () => {
			const rows = Array.from({ length: 6 }, (_, i) => makeObject(String(i), 1))
			const originalContent = [
				{ type: 'text', text: 'first block' },
				{ type: 'text', text: 'second block' },
			]
			const response = {
				content: originalContent,
				structuredContent: {
					heroCard: { kind: 'list', tool: 'list_objects' },
					objects: rows,
					page: { limit: rows.length, offset: 0 },
				},
			}
			const result = applyResponseTokenCap('list_objects', response, { maxTokens: 1000 })

			expect(result.truncated).toBe(true)
			const capped = result.response as { content: unknown }
			expect(capped.content).toEqual(originalContent)
		})
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

	it('reports page.returned as the rows that ship, not the pre-trim page size', () => {
		const rows = Array.from({ length: 40 }, (_, i) => makeRowWithCreatedAt(i, 1))
		const response = makeListObjectsResponseWithCursor(rows, '2026-06-30T12:00:00.000Z')
		response.structuredContent.page = {
			...response.structuredContent.page,
			limit: 40,
			returned: rows.length,
		} as typeof response.structuredContent.page
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 500 })
		expect(result.truncated).toBe(true)
		const capped = result.response as {
			structuredContent: { objects: unknown[]; page: { limit: number; returned: number } }
		}
		expect(capped.structuredContent.objects.length).toBeLessThan(rows.length)
		expect(capped.structuredContent.page.returned).toBe(capped.structuredContent.objects.length)
		expect(capped.structuredContent.page.limit).toBe(40)
	})

	it('resumes the walk after the last shipped row when the tool supplies a resume cursor, even on a final page', () => {
		// A final page carries no next_cursor, so there is nothing to rewrite. The
		// tool-supplied builder makes trimmed rows reachable through the cursor.
		const rows = Array.from({ length: 30 }, (_, i) => makeRowWithCreatedAt(i, 1))
		const response = {
			content: [{ type: 'text', text: 'x' }],
			structuredContent: {
				heroCard: {
					kind: 'list',
					tool: 'list_objects',
					page: { limit: 25, offset: 0, hasMore: false },
				},
				objects: rows,
				page: { limit: 30, returned: rows.length },
			},
			[RESUME_CURSOR]: (last: unknown) => `after:${(last as { id: string }).id}`,
		}
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 2500 })
		expect(result.truncated).toBe(true)
		const capped = result.response as {
			structuredContent: {
				heroCard: { page: { hasMore: boolean } }
				objects: Array<{ id: string }>
				next_cursor?: string
				page: { next_cursor?: string; returned: number }
			}
		}
		const kept = capped.structuredContent.objects
		expect(kept.length).toBeGreaterThan(0)
		expect(kept.length).toBeLessThan(rows.length)
		const expected = `after:${kept[kept.length - 1].id}`
		expect(capped.structuredContent.next_cursor).toBe(expected)
		expect(capped.structuredContent.page.next_cursor).toBe(expected)
		expect(capped.structuredContent.page.returned).toBe(kept.length)
		expect(capped.structuredContent.heroCard.page.hasMore).toBe(true)
	})

	it('names only the shipped rows on the card after a trim, and keeps the real totalCount', () => {
		// The tool builds the card from the whole page before the cap runs, so
		// without a sync it names rows that never ship and then repeats them on
		// the next page.
		const rows = Array.from({ length: 30 }, (_, i) => makeRowWithCreatedAt(i, 1))
		const response = {
			content: [{ type: 'text', text: 'x' }],
			structuredContent: {
				heroCard: {
					kind: 'list',
					tool: 'list_objects',
					objects: rows.map((r) => ({ id: r.id, type: r.type, title: r.title })),
					totalCount: 34,
					page: { limit: rows.length, offset: 0, hasMore: false },
				},
				objects: rows,
				page: { limit: 30, returned: rows.length },
			},
			[RESUME_CURSOR]: (last: unknown) => `after:${(last as { id: string }).id}`,
		}
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 2500 })
		expect(result.truncated).toBe(true)
		const capped = result.response as {
			structuredContent: {
				heroCard: {
					objects: Array<{ id: string }>
					totalCount: number
					page: { limit: number; hasMore: boolean }
				}
				objects: Array<{ id: string }>
			}
		}
		const shippedIds = capped.structuredContent.objects.map((r) => r.id)
		expect(shippedIds.length).toBeLessThan(rows.length)
		expect(capped.structuredContent.heroCard.objects.map((o) => o.id)).toEqual(shippedIds)
		expect(capped.structuredContent.heroCard.totalCount).toBe(34)
		expect(capped.structuredContent.heroCard.page.limit).toBe(shippedIds.length)
		expect(capped.structuredContent.heroCard.page.hasMore).toBe(true)
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

	it('ships a single row that is over the cap on its own, untrimmed', () => {
		// _meta alone is above a 5-token cap. There is nothing to drop, and a page
		// with zero rows would stall a cursor walk, so the row ships as it came.
		const rows = [makeObject('a', 1)]
		const response = {
			_meta: { padding: 'z'.repeat(4096) },
			content: [{ type: 'text', text: '- 1 row' }],
			structuredContent: { objects: rows },
		}
		const result = applyResponseTokenCap('list_objects', response, { maxTokens: 5 })
		expect(result.truncated).toBe(false)
		expect(result.response).toBe(response)
	})

	it('keeps one row when every row is over the cap, and hands the rest to fetch_handle', () => {
		const rows = [makeObject('a', 4), makeObject('b', 4), makeObject('c', 4)]
		const result = applyResponseTokenCap('list_objects', makeListObjectsResponse(rows), {
			maxTokens: 100,
		})
		expect(result.truncated).toBe(true)
		const capped = result.response as {
			_meta: { truncated: boolean; fetch_handle: { ids: string[] } }
			structuredContent: { objects: Array<{ id: string }> }
		}
		expect(capped.structuredContent.objects.map((o) => o.id)).toEqual(['a'])
		expect(capped._meta.fetch_handle.ids).toEqual(['b', 'c'])
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

	it('AC-T6: calling fetch_handle.tool with fetch_handle.ids returns the omitted rows without re-truncation', async () => {
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

	describe('a trimmed page keeps a cursor, so a walk skips no rows', () => {
		const ROW_COUNT = 30
		const PAGE_LIMIT = 10

		type Page = {
			_meta?: { truncated?: boolean }
			structuredContent: Record<string, unknown> & { next_cursor?: string }
		}

		// Newest first, one second apart, so (createdAt, id) is a strict keyset order.
		function createdAtOf(idx: number) {
			return new Date(Date.UTC(2026, 0, 1) + (ROW_COUNT - idx) * 1000).toISOString()
		}

		// Well over the 4000-token cap used below, so this one row cannot fit on any page.
		const OVERSIZED_PADDING = 40 * 1024

		function objectRows(count: number, oversizedIdx?: number) {
			return Array.from({ length: count }, (_, i) => {
				const row = { ...bigObjectRow(i), createdAt: createdAtOf(i) }
				if (i === oversizedIdx) row.metadata = { padding: 'x'.repeat(OVERSIZED_PADDING) }
				return row
			})
		}

		function relationshipRows(count: number, oversizedIdx?: number) {
			return Array.from({ length: count }, (_, i) => ({
				id: `rel-${String(i).padStart(12, '0')}`,
				sourceId: `src-${i}`,
				targetId: `tgt-${i}`,
				type: 'in_loop',
				createdAt: createdAtOf(i),
				sourceTitle: 'x'.repeat(i === oversizedIdx ? OVERSIZED_PADDING : 3072),
				targetTitle: `Target ${i}`,
			}))
		}

		// Serves /api/objects and /api/relationships the way the API does: only rows strictly
		// after the keyset cursor (newest first), at most `limit` of them.
		function stubKeysetApi(fixture: Array<{ id: string; createdAt: string }>) {
			vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
				const parsed = new URL(url as string)
				if (!/^\/api\/(objects|relationships)$/.test(parsed.pathname)) {
					return { ok: true, headers: new Headers(), json: () => Promise.resolve([]) } as Response
				}
				const cursorAt = parsed.searchParams.get('cursor_created_at')
				const cursorId = parsed.searchParams.get('cursor_id')
				const limit = Number(parsed.searchParams.get('limit'))
				const rows = fixture
					.filter(
						(r) =>
							!cursorAt ||
							!cursorId ||
							r.createdAt < cursorAt ||
							(r.createdAt === cursorAt && r.id < cursorId),
					)
					.slice(0, limit)
				return { ok: true, headers: new Headers(), json: () => Promise.resolve(rows) } as Response
			})
		}

		function callTool(tool: string, args: Record<string, unknown>) {
			const handler = handlers.get(tool)
			if (!handler) throw new Error(`${tool} handler not registered`)
			return handler(args) as Promise<Page>
		}

		const cases = [
			{ tool: 'list_objects', rowsField: 'objects', makeRows: objectRows },
			{ tool: 'list_relationships', rowsField: 'relationships', makeRows: relationshipRows },
		]

		for (const { tool, rowsField, makeRows } of cases) {
			it(`${tool}: walking trimmed middle and final pages returns every row exactly once`, async () => {
				process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '4000'
				const fixture = makeRows(ROW_COUNT)
				stubKeysetApi(fixture)

				const seen: string[] = []
				const pages: Page[] = []
				let cursor: string | undefined
				// Bounded so a cursor that never advances fails the test instead of hanging it.
				for (let hop = 0; hop < ROW_COUNT + 2; hop++) {
					const page = await callTool(tool, { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })
					pages.push(page)
					const rows = page.structuredContent[rowsField] as Array<{ id: string }>
					seen.push(...rows.map((r) => r.id))
					cursor = page.structuredContent.next_cursor
					if (!cursor) break
				}

				expect(seen).toEqual(fixture.map((r) => r.id))
				// The cap cut many pages, including ones the API sent with no cursor of
				// its own (fewer than PAGE_LIMIT rows left), and only the last page ends the walk.
				expect(pages.filter((p) => p._meta?.truncated).length).toBeGreaterThan(2)
				expect(pages.at(-1)?.structuredContent.next_cursor).toBeUndefined()
			})

			// The first row, a row that starts a later page, and the last row.
			for (const oversizedIdx of [0, 12, ROW_COUNT - 1]) {
				it(`${tool}: a walk with row ${oversizedIdx} over the cap returns every row exactly once and never stops early`, async () => {
					process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '4000'
					const fixture = makeRows(ROW_COUNT, oversizedIdx)
					stubKeysetApi(fixture)

					const seen: string[] = []
					let cursor: string | undefined
					// Bounded so a cursor that never advances fails the test instead of hanging it.
					for (let hop = 0; hop < ROW_COUNT + 2; hop++) {
						const page = await callTool(tool, { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) })
						const rows = page.structuredContent[rowsField] as Array<{ id: string }>
						// No page, including the one holding the oversized row, ships empty.
						expect(rows.length).toBeGreaterThan(0)
						seen.push(...rows.map((r) => r.id))
						cursor = page.structuredContent.next_cursor
						if (!cursor) break
					}

					expect(seen).toEqual(fixture.map((r) => r.id))
					expect(cursor).toBeUndefined()
				})
			}

			it(`${tool}: a trimmed page that held the whole list still emits a cursor after the last shipped row`, async () => {
				process.env[RESPONSE_TOKEN_CAP_ENV_VAR] = '4000'
				// 6 rows is under the page limit, so the API sends no cursor of its own.
				const fixture = makeRows(6)
				stubKeysetApi(fixture)

				const page = await callTool(tool, { limit: PAGE_LIMIT })
				const shipped = page.structuredContent[rowsField] as Array<{ id: string }>
				expect(page._meta?.truncated).toBe(true)
				expect(shipped.length).toBeGreaterThan(0)
				expect(shipped.length).toBeLessThan(fixture.length)

				const next = page.structuredContent.next_cursor
				expect(next).toBeTruthy()
				expect(decodeCursor(next)?.k.id).toBe(shipped.at(-1)?.id)

				const rest = await callTool(tool, { limit: PAGE_LIMIT, cursor: next })
				const restRows = rest.structuredContent[rowsField] as Array<{ id: string }>
				expect(restRows[0]?.id).toBe(fixture[shipped.length].id)
			})
		}
	})
})

describe('replies that are not a list of rows', () => {
	const text = (n: number) => 'lorem ipsum "quoted" '.repeat(n)
	const textBlock = (value: unknown) => ({ type: 'text', text: JSON.stringify(value) })

	describe('get_objects', () => {
		const object = (i: number, words: number) => ({
			object: { id: `o${i}`, title: `Object ${i}`, content: text(words) },
		})
		function getObjectsResponse(objects: ReturnType<typeof object>[]) {
			return {
				content: [textBlock(objects.map((o) => ({ id: o.object.id, success: true, result: o })))],
				structuredContent: {
					heroCard: {
						kind: 'list',
						tool: 'get_objects',
						objects: objects.map((o) => ({ id: o.object.id })),
						totalCount: objects.length,
						page: { limit: objects.length, offset: 0, hasMore: false },
					},
					results: objects.map((o) => ({ id: o.object.id, success: true })),
					objects,
				},
			}
		}

		it('is registered with the id nested in each row and the content shape kept', () => {
			expect(TOKEN_CAP_TARGETS.get_objects).toMatchObject({
				fetchHandleTool: 'get_objects',
				rowsField: 'objects',
				idField: 'object.id',
				keepContentShape: true,
			})
		})

		it('cuts objects from the tail, keeps the text a per-id array, and says what was left out', () => {
			const objects = Array.from({ length: 12 }, (_, i) => object(i, 50))
			const result = applyResponseTokenCap('get_objects', getObjectsResponse(objects), {
				maxTokens: 2000,
			})
			expect(result.truncated).toBe(true)
			const capped = result.response as ReturnType<typeof getObjectsResponse> & {
				_meta: { truncated: boolean; fetch_handle: { tool: string; ids: string[] } }
			}
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(2000)

			const shipped = capped.structuredContent.objects.map((o) => o.object.id)
			const omitted = capped._meta.fetch_handle.ids
			expect([...shipped, ...omitted]).toEqual(objects.map((o) => o.object.id))
			expect(capped._meta.fetch_handle.tool).toBe('get_objects')

			// The text keeps its own shape (an array of per-id results), minus the omitted ids.
			const text0 = JSON.parse((capped.content[0] as { text: string }).text) as Array<{
				id: string
				result: unknown
			}>
			expect(text0.map((e) => e.id)).toEqual(shipped)
			expect(text0[0]).toHaveProperty('result')

			// The card lists only the rows that shipped.
			expect(capped.structuredContent.heroCard.objects.map((o) => o.id)).toEqual(shipped)

			// The payload says so in plain words, in both channels.
			const structured = capped.structuredContent as unknown as {
				truncated: boolean
				omitted_count: number
				omitted_ids: string[]
				notice: string
			}
			expect(structured.truncated).toBe(true)
			expect(structured.omitted_count).toBe(omitted.length)
			expect(structured.omitted_ids).toEqual(omitted)
			expect(structured.notice).toContain(`Showing ${shipped.length} of 12 objects`)
			const noticeBlock = JSON.parse((capped.content.at(-1) as { text: string }).text)
			expect(noticeBlock).toMatchObject({ truncated: true, omitted_count: omitted.length })
			expect(noticeBlock.notice).toBe(structured.notice)
		})

		it('cuts the long text of a lone object that is over the cap and names the field', () => {
			const result = applyResponseTokenCap('get_objects', getObjectsResponse([object(0, 20_000)]), {
				maxTokens: 2000,
			})
			expect(result.truncated).toBe(true)
			const capped = result.response as ReturnType<typeof getObjectsResponse>
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(2000)
			const body = capped.structuredContent.objects[0].object.content
			expect(body).toContain('more characters cut]')
			expect(body.length).toBeLessThan(text(20_000).length)
			const structured = capped.structuredContent as unknown as { notice: string }
			expect(structured.notice).toContain('objects.0.object.content')
			// The text copy is cut by the same amount, and its shape is still the per-id array.
			const text0 = JSON.parse((capped.content[0] as { text: string }).text) as Array<{
				result: { object: { content: string } }
			}>
			expect(text0[0].result.object.content).toContain('more characters cut]')
		})

		it('ships a reply under the cap untouched', () => {
			const response = getObjectsResponse([object(0, 5)])
			const result = applyResponseTokenCap('get_objects', response, { maxTokens: 2000 })
			expect(result.truncated).toBe(false)
			expect(result.response).toBe(response)
		})
	})

	describe('get_comments', () => {
		const comment = (i: number) => ({
			id: 100 - i,
			createdAt: `2026-11-1${i % 9}T00:00:00.000Z`,
			data: { content: text(20) },
		})
		function commentsResponse(count: number, resume?: (row: unknown) => string | null) {
			const comments = Array.from({ length: count }, (_, i) => comment(i))
			return {
				content: [
					textBlock({
						page: { limit: count, returned: count, total: null, has_more: false },
						comments,
					}),
				],
				structuredContent: { comments },
				...(resume ? { [RESUME_CURSOR]: resume } : {}),
			}
		}

		it('keeps the page shape of the text, marks it truncated and says how to continue', () => {
			const resume = (row: unknown) => `after-${(row as { id: number }).id}`
			const result = applyResponseTokenCap('get_comments', commentsResponse(40, resume), {
				maxTokens: 3000,
			})
			expect(result.truncated).toBe(true)
			const capped = result.response as {
				content: Array<{ text: string }>
				structuredContent: { comments: Array<{ id: number }>; next_cursor: string; notice: string }
			}
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(3000)

			const shipped = capped.structuredContent.comments
			const page = JSON.parse(capped.content[0].text) as {
				page: { returned: number; has_more: boolean }
				comments: Array<{ id: number }>
				truncated: boolean
				notice: string
				next_cursor: string
			}
			expect(page.comments).toEqual(shipped)
			expect(page.page).toMatchObject({ returned: shipped.length, has_more: true })
			expect(page.truncated).toBe(true)
			expect(page.notice).toBe(capped.structuredContent.notice)
			expect(page.notice).toContain(`Showing ${shipped.length} of 40 comments`)
			expect(page.notice).toContain('next_cursor')
			// The walk resumes after the last comment that shipped.
			expect(capped.structuredContent.next_cursor).toBe(`after-${shipped.at(-1)?.id}`)
			expect(page.next_cursor).toBe(capped.structuredContent.next_cursor)
		})
	})

	describe('get_session_logs', () => {
		const line = (id: number) => ({
			id,
			sessionId: 's1',
			stream: 'stdout',
			content: text(40),
			createdAt: 't',
		})

		it('keeps the array of rows, names the id to continue from and sets _meta.truncated', () => {
			const lines = Array.from({ length: 300 }, (_, i) => line(1000 - i))
			const response = { content: [textBlock(lines)] }
			const result = applyResponseTokenCap('get_session_logs', response, { maxTokens: 3000 })
			expect(result.truncated).toBe(true)
			const capped = result.response as {
				content: Array<{ text: string }>
				_meta: { truncated: boolean }
			}
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(3000)
			const shipped = JSON.parse(capped.content[0].text) as Array<{ id: number }>
			expect(Array.isArray(shipped)).toBe(true)
			expect(shipped.length).toBeLessThan(300)
			expect(shipped[0]).toEqual(lines[0])
			expect(capped._meta.truncated).toBe(true)
			const notice = JSON.parse(capped.content[1].text) as { truncated: boolean; notice: string }
			expect(notice.truncated).toBe(true)
			expect(notice.notice).toContain(`Showing ${shipped.length} of 300 log lines`)
			expect(notice.notice).toContain(`before_id ${shipped.at(-1)?.id}`)
		})

		it('continues forward with after_id when the rows run oldest first', () => {
			const lines = Array.from({ length: 300 }, (_, i) => line(i + 1))
			const result = applyResponseTokenCap(
				'get_session_logs',
				{ content: [textBlock(lines)] },
				{ maxTokens: 3000 },
			)
			const capped = result.response as { content: Array<{ text: string }> }
			const shipped = JSON.parse(capped.content[0].text) as Array<{ id: number }>
			expect(JSON.parse(capped.content[1].text).notice).toContain(`after_id ${shipped.at(-1)?.id}`)
		})

		it('cuts the text of one huge line instead of shipping it whole', () => {
			const result = applyResponseTokenCap(
				'get_session_logs',
				{ content: [textBlock([{ ...line(1), content: text(50_000) }])] },
				{ maxTokens: 3000 },
			)
			const capped = result.response as { content: Array<{ text: string }> }
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(3000)
			const [only] = JSON.parse(capped.content[0].text) as Array<{ content: string }>
			expect(only.content).toContain('more characters cut]')
			expect(JSON.parse(capped.content[1].text).notice).toContain('0.content')
		})

		it('ships a page under the cap untouched', () => {
			const response = { content: [textBlock([line(2), line(1)])] }
			const result = applyResponseTokenCap('get_session_logs', response, { maxTokens: 3000 })
			expect(result.truncated).toBe(false)
			expect(result.response).toBe(response)
		})
	})

	describe('get_session', () => {
		it('cuts a long prompt and log lines both, so the lines are not all pushed out by the prompt', () => {
			const logs = Array.from({ length: 100 }, (_, i) => ({ id: 500 - i, content: text(40) }))
			const record = { session: { id: 'sess-1', actionPrompt: text(30_000) }, logs }
			const result = applyResponseTokenCap(
				'get_session',
				{ content: [textBlock(record)] },
				{ maxTokens: 4000 },
			)
			expect(result.truncated).toBe(true)
			const capped = result.response as { content: Array<{ text: string }> }
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(4000)
			const body = JSON.parse(capped.content[0].text) as {
				truncated: boolean
				notice: string
				session: { id: string; actionPrompt: string }
				logs: Array<{ id: number }>
			}
			expect(body.truncated).toBe(true)
			expect(Object.keys(body).slice(0, 2)).toEqual(['truncated', 'notice'])
			expect(body.session.id).toBe('sess-1')
			expect(body.session.actionPrompt).toContain('more characters cut]')
			expect(body.logs.length).toBeGreaterThan(1)
			expect(body.logs.length).toBeLessThan(100)
			expect(body.notice).toContain('session.actionPrompt')
			expect(body.notice).toContain(
				`get_session_logs with id sess-1 and before_id ${body.logs.at(-1)?.id}`,
			)
		})

		it('leaves a session without logs alone when it fits', () => {
			const response = { content: [textBlock({ id: 'sess-1', status: 'completed' })] }
			const result = applyResponseTokenCap('get_session', response, { maxTokens: 3000 })
			expect(result.truncated).toBe(false)
			expect(result.response).toBe(response)
		})
	})

	describe('get_file', () => {
		it('cuts a long text file, keeps its fields and names the offset to read on from', () => {
			const file = { id: 'f1', name: 'big.md', encoding: 'utf8', content: text(50_000) }
			const result = applyResponseTokenCap(
				'get_file',
				{ content: [textBlock(file)] },
				{ maxTokens: 3000 },
			)
			expect(result.truncated).toBe(true)
			const capped = result.response as { content: Array<{ text: string }> }
			expect(estimateResponseTokens(capped)).toBeLessThanOrEqual(3000)
			const body = JSON.parse(capped.content[0].text) as {
				notice: string
				id: string
				name: string
				encoding: string
				content: string
			}
			expect(body).toMatchObject({ id: 'f1', name: 'big.md', encoding: 'utf8' })
			const head = body.content.split('… [')[0]
			expect(text(50_000).startsWith(head)).toBe(true)
			expect(body.notice).toContain(`call get_file again with offset ${head.length}`)
			expect(body.notice).toContain('format "text"')
		})

		it('continues from an earlier offset', () => {
			const file = { id: 'f1', encoding: 'utf8', offset: 1000, content: text(50_000) }
			const result = applyResponseTokenCap(
				'get_file',
				{ content: [textBlock(file)] },
				{ maxTokens: 3000 },
			)
			const capped = result.response as { content: Array<{ text: string }> }
			const body = JSON.parse(capped.content[0].text) as { notice: string; content: string }
			const head = body.content.split('… [')[0]
			expect(body.notice).toContain(`offset ${1000 + head.length}`)
		})

		it('leaves an image reply (a text block plus an image block) alone', () => {
			const response = {
				content: [
					textBlock({ id: 'f1', mimeType: 'image/png' }),
					{ type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/png' },
				],
			}
			const result = applyResponseTokenCap('get_file', response, { maxTokens: 3000 })
			expect(result.truncated).toBe(false)
			expect(result.response).toBe(response)
		})
	})

	it('registers all three record tools', () => {
		expect(Object.keys(RECORD_CAP_TARGETS).sort()).toEqual([
			'get_file',
			'get_session',
			'get_session_logs',
		])
	})

	it('honours the MCP_RESPONSE_MAX_TOKENS override on a record tool', () => {
		const file = { id: 'f1', encoding: 'utf8', content: text(5000) }
		const response = { content: [textBlock(file)] }
		const roomy = applyResponseTokenCap('get_file', response, {
			env: { [RESPONSE_TOKEN_CAP_ENV_VAR]: '100000' },
		})
		expect(roomy.truncated).toBe(false)
		const tight = applyResponseTokenCap('get_file', response, {
			env: { [RESPONSE_TOKEN_CAP_ENV_VAR]: '1000' },
		})
		expect(tight.truncated).toBe(true)
	})

	it('adds a plain notice to a tool that was already capped', () => {
		const rows = Array.from({ length: 6 }, (_, i) => ({ id: String(i), body: 'y'.repeat(1024) }))
		const payload = { objects: rows, page: { limit: 6, returned: 6, total: null, has_more: false } }
		const result = applyResponseTokenCap(
			'list_objects',
			{ content: [textBlock(payload)], structuredContent: payload },
			{ maxTokens: 1000 },
		)
		const structured = (result.response as { structuredContent: { notice: string } })
			.structuredContent
		expect(structured.notice).toMatch(/^Showing \d+ of 6 objects/)
	})
})
